/**
 * Server-side view computation — the single source of truth for what the
 * client receives over the WebSocket.
 *
 * `computeView` merges two responsibilities that previously ran client-side:
 *   1. `visibleGraph()` — node/edge filtering (kinds, paths, patterns, focus)
 *   2. `combinedGroups()` — group container building, collapse logic, edge
 *      promotion through collapsed group boundaries
 *
 * The server calls `computeView` once per `view_request` and sends the result
 * as a `view_snapshot`. The client receives only what ELK needs to lay out —
 * never the full raw graph.
 */

import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from './index.js'

// ── FileGroup ─────────────────────────────────────────────────────────────────
// Moved from packages/client/src/layout/elk.ts so the server can build groups
// and the client can forward them straight to layoutGraph().

/**
 * A group fed to layoutGraph to enable compound-node layout.
 *
 * Top-level groups (passed in the fileGroups array):
 *   - With filePath → nested inside a dir compound (file grouping, class grouping)
 *   - Without filePath → direct root compound (contract grouping)
 *
 * childGroups (optional sub-compound nesting, one level deep):
 *   - Class containers inside file containers use this.
 *   - childGroups inherit their parent's filePath for dir placement.
 */
export interface FileGroup {
  /** ELK compound node id. */
  id: string
  /** Display label for the container box. */
  label: string
  /** Leaf node ids directly inside this compound (not in any childGroup). */
  childIds: string[]
  /** Optional one-level-deep sub-compounds (e.g. class containers inside a file). */
  childGroups?: FileGroup[]
  /**
   * Full file path — determines directory grouping.
   * When omitted the group becomes a flat root-level compound.
   */
  filePath?: string
  /**
   * Optional accent color (CSS hex, e.g. '#10b981').
   * Passed through to FileContainer for coloured-border rendering.
   */
  color?: string
  /**
   * Package path (e.g. 'packages/client') — triggers 4-tier layout when
   * combined with filePath. File groups with this set get wrapped in a
   * package compound. Omit for flat groups.
   */
  packagePath?: string
  /**
   * True when this group is collapsed in the hierarchy view.
   * `childIds` will be empty; ELK renders the container as a fixed-size
   * placeholder so that edges can still connect to and from it.
   */
  collapsed?: boolean
}

// ── ViewParams ────────────────────────────────────────────────────────────────

/**
 * All client-side UI state that affects what the server sends.
 * The client persists these locally and sends them on every change.
 */
export interface ViewParams {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  /** Path keys hidden via the HierarchyPanel eye toggles (prefix-match semantics). */
  hiddenPaths: string[]
  /** Comma-separated glob patterns excluded from the visible graph. */
  excludePatterns: string
  groupByFile: boolean
  groupByClass: boolean
  groupByContract: boolean
  groupByPackage: boolean
  /** File paths / dir prefixes whose groups show children expanded in ELK layout. */
  expandedGroups: string[]
  focusedNodeId: string | null
}

/** Default params sent to the server before the client has loaded any local prefs. */
export const DEFAULT_VIEW_PARAMS: ViewParams = {
  hiddenNodeKinds: [],
  // `contains` edges are structural hierarchy already shown by spatial containers —
  // rendering them as lines creates noisy bands especially in dense graphs.
  // `exports` mirrors imports and adds identical routing clutter.
  hiddenEdgeKinds: ['contains', 'exports'],
  hiddenPaths: [],
  excludePatterns: '',
  groupByFile: true,
  groupByClass: false,
  groupByContract: false,
  groupByPackage: false,
  expandedGroups: [],
  focusedNodeId: null
}

// ── ViewResult ────────────────────────────────────────────────────────────────

/** What the server sends in a `view_snapshot` message. */
export interface ViewResult {
  /**
   * Nodes ready for ELK layout.
   * - Symbol nodes inside expanded groups (file/class nodes removed when
   *   group mode is on — they become `groups` instead).
   * - Collapsed group containers (placeholder nodes — no children).
   * - Ungrouped symbol nodes.
   */
  nodes: GraphNode[]
  /**
   * Edges ready for ELK.
   * - Collapsed-child endpoint IDs promoted to their group container ID.
   * - Filtered by edge kind, endpoint visibility, and deduplicated.
   */
  edges: GraphEdge[]
  /**
   * ELK compound group hierarchy.
   * Empty when no grouping is active.
   */
  groups: FileGroup[]
  /**
   * All file-kind nodes in the raw graph — used by the HierarchyPanel
   * sidebar to build the directory/package tree regardless of view params.
   */
  fileNodes: GraphNode[]
}

// ── Contract group definitions ────────────────────────────────────────────────
// Moved from client/src/canvas/GraphCanvas.tsx so the server can apply them.

interface ContractGroupDef {
  id: string
  label: string
  color: string
  test: (node: GraphNode) => boolean
}

const CONTRACT_GROUPS: ContractGroupDef[] = [
  {
    id: '__contract_rest',
    label: 'REST API',
    color: '#10b981',
    test: (n) =>
      n.kind === 'route' ||
      /\.(controller|router|route|handler|endpoint)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /[\\/](controllers?|routes?|handlers?|endpoints?)[\\/]/i.test(n.filePath ?? '')
  },
  {
    id: '__contract_ws',
    label: 'WebSocket',
    color: '#06b6d4',
    test: (n) =>
      /\.(gateway|socket|hub|ws)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /[\\/](gateways?|sockets?|hubs?)[\\/]/i.test(n.filePath ?? '')
  },
  {
    id: '__contract_graphql',
    label: 'GraphQL',
    color: '#e879f9',
    test: (n) =>
      /\.(resolver|typedef)\.[jt]sx?$/i.test(n.filePath ?? '') ||
      /\.(graphql|gql)$/i.test(n.filePath ?? '') ||
      /[\\/](resolvers?|graphql)[\\/]/i.test(n.filePath ?? '') ||
      /(Query|Mutation|Subscription|Resolver)$/.test(n.name)
  }
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a single glob pattern (`*` = wildcard) to a case-insensitive RegExp.
 * Returns null for empty / invalid patterns.
 */
export function globToRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null
  const regexStr = trimmed
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  try {
    return new RegExp(regexStr, 'i')
  } catch {
    return null
  }
}

function extractPackagePath(fp?: string): string | undefined {
  if (!fp) return undefined
  const m = fp.match(/^(packages\/[^/]+)/)
  return m?.[1]
}

function deduplicateById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>()
  const out: GraphNode[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
  }
  return out.length === nodes.length ? nodes : out
}

function isHiddenByPath(node: GraphNode, hSet: Set<string>): boolean {
  if (hSet.has(node.id)) return true
  const fp = node.filePath
  if (!fp) return false
  const parts = fp.replace(/\\/g, '/').split('/')
  for (let i = 1; i <= parts.length; i++) {
    if (hSet.has(parts.slice(0, i).join('/'))) return true
  }
  return false
}

function isGroupExpanded(filePath: string | undefined, expandedGroups: string[]): boolean {
  if (!filePath) return true
  return expandedGroups.some((prefix) => filePath === prefix || filePath.startsWith(prefix + '/'))
}

function collectDescendants(nodeId: string, containsChildren: Map<string, string[]>, out: Set<string>): void {
  for (const child of containsChildren.get(nodeId) ?? []) {
    out.add(child)
    collectDescendants(child, containsChildren, out)
  }
}

function fileLabel(fn: GraphNode): string {
  const name = fn.name
  return name && !name.includes('/') ? name : ((fn.filePath ?? name ?? fn.id).split('/').pop() ?? fn.id)
}

// ── computeView ───────────────────────────────────────────────────────────────

/**
 * Compute everything the client needs for the current view.
 *
 * Takes the full raw graph and all view parameters, and returns only what
 * needs to be sent over the wire — a fraction of the raw data for most
 * collapsed/filtered views.
 *
 * Pure function: no side effects, no I/O.
 */
export function computeView(allNodes: GraphNode[], allEdges: GraphEdge[], params: ViewParams): ViewResult {
  const {
    hiddenNodeKinds,
    hiddenEdgeKinds,
    hiddenPaths,
    excludePatterns,
    groupByFile,
    groupByClass,
    groupByContract,
    groupByPackage,
    expandedGroups,
    focusedNodeId
  } = params

  // Always collect file nodes for the hierarchy panel — independent of view params.
  const fileNodes = allNodes.filter((n) => n.kind === 'file' || n.kind === 'module')

  // ── Phase 0: deduplicate input nodes ────────────────────────────────────
  // Diff views can produce duplicate IDs when nodeSemanticId collides
  // (kind + name + signature match across files). ELK throws
  // "value already present" if any two children share an id.
  // eslint-disable-next-line no-param-reassign
  allNodes = deduplicateById(allNodes)

  // ── Phase 1: node filtering (mirrors visibleGraph) ────────────────────────

  const hiddenKindSet = new Set<NodeKind>(hiddenNodeKinds)
  let nodes = allNodes.filter((n) => !hiddenKindSet.has(n.kind))
  let nodeIds = new Set(nodes.map((n) => n.id))

  // hiddenPaths filter (prefix-match semantics)
  if (hiddenPaths.length > 0) {
    const hSet = new Set(hiddenPaths)
    nodes = nodes.filter((n) => !isHiddenByPath(n, hSet))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // excludePatterns filter
  if (excludePatterns.trim()) {
    const regexes = excludePatterns
      .split(',')
      .map(globToRegex)
      .filter((r): r is RegExp => r !== null)
    if (regexes.length > 0) {
      nodes = nodes.filter((n) => {
        const fp = n.filePath ?? ''
        return !regexes.some((r) => r.test(fp))
      })
      nodeIds = new Set(nodes.map((n) => n.id))
    }
  }

  // ── Phase 2: import node elevation ───────────────────────────────────────

  const syntheticImportEdges: GraphEdge[] = []
  {
    const importIds = new Set<string>()
    for (const n of nodes) {
      if (n.kind === 'import') importIds.add(n.id)
    }

    if (importIds.size > 0) {
      const importContainers = new Map<string, Set<string>>()
      const importTargets = new Map<string, Set<string>>()

      for (const e of allEdges) {
        if (e.kind === 'contains' && importIds.has(e.target)) {
          if (!importContainers.has(e.target)) importContainers.set(e.target, new Set())
          importContainers.get(e.target)!.add(e.source)
        }
        if (e.kind === 'imports' && importIds.has(e.source)) {
          if (!importTargets.has(e.source)) importTargets.set(e.source, new Set())
          importTargets.get(e.source)!.add(e.target)
        }
      }

      for (const [importId, containerIds] of importContainers) {
        const targetIds = importTargets.get(importId)
        if (!targetIds) continue
        for (const cid of containerIds) {
          for (const tid of targetIds) {
            if (nodeIds.has(cid) && nodeIds.has(tid) && cid !== tid) {
              syntheticImportEdges.push({ source: cid, target: tid, kind: 'imports' })
            }
          }
        }
      }

      nodes = nodes.filter((n) => !importIds.has(n.id))
      nodeIds = new Set(nodes.map((n) => n.id))
    }
  }

  // ── Phase 3: grouping coercion ────────────────────────────────────────────
  // Remove file/class nodes from the layout node set — they become spatial
  // containers drawn by the renderer, not graph nodes in ELK.

  if (groupByFile || groupByContract || groupByPackage) {
    nodes = nodes.filter((n) => n.kind !== 'file' && n.kind !== 'module')
    nodeIds = new Set(nodes.map((n) => n.id))
  }
  if (groupByClass) {
    nodes = nodes.filter((n) => n.kind !== 'class')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // ── Phase 4: focus neighbourhood ─────────────────────────────────────────

  if (focusedNodeId && nodeIds.has(focusedNodeId)) {
    const keep = new Set<string>([focusedNodeId])
    for (const e of allEdges) {
      if (e.source === focusedNodeId && nodeIds.has(e.target)) keep.add(e.target)
      if (e.target === focusedNodeId && nodeIds.has(e.source)) keep.add(e.source)
    }
    nodes = nodes.filter((n) => keep.has(n.id))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // ── Phase 5: edge filtering ───────────────────────────────────────────────

  const hiddenEdgeSet = new Set<EdgeKind>(hiddenEdgeKinds)
  const seenEdgeKeys = new Set<string>()
  const filteredEdges: GraphEdge[] = []

  for (const e of allEdges) {
    if (hiddenEdgeSet.has(e.kind)) continue
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source}|${e.target}|${e.kind}`
    if (seenEdgeKeys.has(key)) continue
    seenEdgeKeys.add(key)
    filteredEdges.push(e)
  }

  for (const e of syntheticImportEdges) {
    const key = `${e.source}|${e.target}|${e.kind}`
    if (!seenEdgeKeys.has(key)) {
      seenEdgeKeys.add(key)
      filteredEdges.push(e)
    }
  }

  // ── Phase 6: no grouping — return flat result ─────────────────────────────

  if (!groupByFile && !groupByClass && !groupByContract && !groupByPackage) {
    return { nodes, edges: filteredEdges, groups: [], fileNodes }
  }

  // ── Phase 7: group building (mirrors combinedGroups) ─────────────────────

  // Build containsChildren from ALL edges (not filtered — need the full hierarchy)
  const containsChildren = new Map<string, string[]>()
  for (const e of allEdges) {
    if (e.kind !== 'contains') continue
    let ch = containsChildren.get(e.source)
    if (!ch) containsChildren.set(e.source, (ch = []))
    ch.push(e.target)
  }

  const visibleNodeIds = nodeIds // already-filtered symbol nodes
  const groups: FileGroup[] = []
  const claimedByContract = new Set<string>()
  // Guard against multi-parent claims — a node must appear in at most one
  // group's childIds.  Diff views can produce `contains` edges that give a
  // single semantic ID two parents (e.g. identically-named helpers in
  // different files).  First group to claim a node wins.
  const claimedByGroup = new Set<string>()
  const collapsedChildIds = new Set<string>()
  const collapsedChildToGroup = new Map<string, string>()

  // 7a. Contract groups — no collapse support (no HierarchyPanel 1-1 link)
  if (groupByContract) {
    const assigned = new Set<string>()
    for (const def of CONTRACT_GROUPS) {
      const childIds = nodes.filter((n) => !assigned.has(n.id) && def.test(n)).map((n) => n.id)
      if (childIds.length === 0) continue
      childIds.forEach((id) => {
        assigned.add(id)
        claimedByContract.add(id)
      })
      groups.push({ id: def.id, label: def.label, color: def.color, childIds })
    }
  }

  // 7b. File groups (with optional class sub-groups)
  if (groupByFile) {
    const rawFileNodes = allNodes.filter((n) => n.kind === 'file' || n.kind === 'module')
    for (const fn of rawFileNodes) {
      const allDesc = new Set<string>()
      collectDescendants(fn.id, containsChildren, allDesc)
      for (const id of claimedByContract) allDesc.delete(id)

      const expanded = isGroupExpanded(fn.filePath, expandedGroups)

      if (!expanded) {
        // Collapsed: exclude all visible descendants from ELK, push empty container.
        const visibleChildIds = [...allDesc].filter((id) => visibleNodeIds.has(id) && !claimedByGroup.has(id))
        if (visibleChildIds.length === 0) continue
        for (const id of visibleChildIds) {
          claimedByGroup.add(id)
          collapsedChildIds.add(id)
          collapsedChildToGroup.set(id, fn.id)
        }
        groups.push({
          id: fn.id,
          label: fileLabel(fn),
          childIds: [],
          childGroups: undefined,
          filePath: fn.filePath,
          packagePath: groupByPackage ? extractPackagePath(fn.filePath) : undefined,
          collapsed: true
        })
        continue
      }

      // Expanded: build child lists as normal.
      if (groupByClass) {
        const childGroups: FileGroup[] = []
        const assignedToClass = new Set<string>()
        for (const classId of containsChildren.get(fn.id) ?? []) {
          const classNode = allNodes.find((n) => n.id === classId && n.kind === 'class')
          if (!classNode) continue
          const classChildIds = (containsChildren.get(classId) ?? []).filter(
            (id) => visibleNodeIds.has(id) && !claimedByContract.has(id) && !claimedByGroup.has(id)
          )
          if (classChildIds.length === 0) continue
          classChildIds.forEach((id) => {
            assignedToClass.add(id)
            claimedByGroup.add(id)
          })
          childGroups.push({ id: classId, label: classNode.name, color: '#818cf8', childIds: classChildIds })
        }
        const leafIds = [...allDesc].filter(
          (id) => visibleNodeIds.has(id) && !assignedToClass.has(id) && !claimedByGroup.has(id)
        )
        if (leafIds.length === 0 && childGroups.length === 0) continue
        for (const id of leafIds) claimedByGroup.add(id)
        groups.push({
          id: fn.id,
          label: fileLabel(fn),
          childIds: leafIds,
          childGroups: childGroups.length > 0 ? childGroups : undefined,
          filePath: fn.filePath,
          packagePath: groupByPackage ? extractPackagePath(fn.filePath) : undefined
        })
      } else {
        const childIds = [...allDesc].filter((id) => visibleNodeIds.has(id) && !claimedByGroup.has(id))
        if (childIds.length === 0) continue
        for (const id of childIds) claimedByGroup.add(id)
        groups.push({
          id: fn.id,
          label: fileLabel(fn),
          childIds,
          filePath: fn.filePath,
          packagePath: groupByPackage ? extractPackagePath(fn.filePath) : undefined
        })
      }
    }
  } else if (groupByClass) {
    // 7c. Class-only groups (no file grouping)
    const classNodes = allNodes.filter((n) => n.kind === 'class')
    for (const cn of classNodes) {
      const childIds = (containsChildren.get(cn.id) ?? []).filter(
        (id) => visibleNodeIds.has(id) && !claimedByContract.has(id) && !claimedByGroup.has(id)
      )
      if (childIds.length === 0) continue
      for (const id of childIds) claimedByGroup.add(id)
      const expanded = isGroupExpanded(cn.filePath, expandedGroups)
      if (!expanded) {
        for (const id of childIds) {
          collapsedChildIds.add(id)
          collapsedChildToGroup.set(id, cn.id)
        }
        groups.push({
          id: cn.id,
          label: cn.name,
          filePath: cn.filePath,
          color: '#818cf8',
          childIds: [],
          collapsed: true
        })
      } else {
        groups.push({ id: cn.id, label: cn.name, filePath: cn.filePath, color: '#818cf8', childIds })
      }
    }
  }

  // 7d. Package-only groups (no file grouping) — no collapse support
  if (groupByPackage && !groupByFile) {
    const pkgMap = new Map<string, string[]>()
    for (const n of nodes) {
      if (claimedByContract.has(n.id)) continue
      const pkg = extractPackagePath(n.filePath)
      if (!pkg) continue
      if (!pkgMap.has(pkg)) pkgMap.set(pkg, [])
      pkgMap.get(pkg)!.push(n.id)
    }
    for (const [pkg, childIds] of pkgMap) {
      if (childIds.length === 0) continue
      groups.push({ id: `__pkg_${pkg.split('/').pop() ?? pkg}`, label: pkg.split('/').pop() ?? pkg, childIds })
    }
  }

  // ── Phase 8: exclude collapsed children from layout nodes ─────────────────

  const layoutNodes = collapsedChildIds.size > 0 ? nodes.filter((n) => !collapsedChildIds.has(n.id)) : nodes

  // ── Phase 9: edge promotion through collapsed group boundaries ────────────

  let layoutEdges = filteredEdges
  if (collapsedChildToGroup.size > 0) {
    const seen = new Set<string>()
    const promoted: GraphEdge[] = []
    for (const e of filteredEdges) {
      const src = collapsedChildToGroup.get(e.source) ?? e.source
      const tgt = collapsedChildToGroup.get(e.target) ?? e.target
      if (src === tgt) continue
      const key = `${src}|${tgt}|${e.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      promoted.push(src === e.source && tgt === e.target ? e : { ...e, source: src, target: tgt })
    }
    layoutEdges = promoted
  }

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    groups: groups.length > 0 ? groups : [],
    fileNodes
  }
}
