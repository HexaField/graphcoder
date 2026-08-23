import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from '@graphcoder/core'
import { state, setState } from './core.js'
import { saveFilters } from './storage.js'
import type { PersistedFilters } from './storage.js'

// ── Filters & focus ───────────────────────────────────────────────────────────

export interface FiltersState {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  /** Comma-separated glob patterns excluded from the visible graph (e.g. `*.test.*, *.config.ts`). */
  excludePatterns: string
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  focusedNodeId: string | null
}

function persist(): void {
  const f: PersistedFilters = {
    hiddenNodeKinds: state.hiddenNodeKinds,
    hiddenEdgeKinds: state.hiddenEdgeKinds,
    excludePatterns: state.excludePatterns,
    groupByFile: state.groupByFile,
    groupByContract: state.groupByContract,
    groupByClass: state.groupByClass,
    groupByPackage: state.groupByPackage
  }
  saveFilters(f)
}

export function toggleNodeKind(kind: NodeKind): void {
  setState('hiddenNodeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persist()
}

export function toggleEdgeKind(kind: EdgeKind): void {
  setState('hiddenEdgeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persist()
}

export function setFocus(nodeId: string): void {
  setState('focusedNodeId', nodeId)
}

export function clearFocus(): void {
  setState('focusedNodeId', null)
}

export function setExcludePatterns(value: string): void {
  setState('excludePatterns', value)
  persist()
}

export function toggleGroupByFile(): void {
  setState('groupByFile', (v) => !v)
  persist()
}

export function toggleGroupByContract(): void {
  setState('groupByContract', (v) => !v)
  persist()
}

export function toggleGroupByClass(): void {
  setState('groupByClass', (v) => !v)
  persist()
}

export function toggleGroupByPackage(): void {
  setState('groupByPackage', (v) => !v)
  persist()
}

export function clearFilters(): void {
  setState('hiddenNodeKinds', [])
  setState('hiddenEdgeKinds', [])
  setState('excludePatterns', '')
  setState('groupByFile', false)
  setState('groupByContract', false)
  setState('groupByClass', false)
  setState('groupByPackage', false)
  persist()
}

// ── Glob-pattern matching ─────────────────────────────────────────────────────

/**
 * Convert a single glob pattern (using `*` as wildcard) to a case-insensitive RegExp.
 * Returns `null` for empty patterns or patterns that produce an invalid regex.
 *
 * Examples:
 *   `*.test.*`   → /.*\.test\..* /i  — matches any path containing `.test.`
 *   `*.config.ts` → /.*\.config\.ts/i
 *   `__tests__`   → /__tests__/i
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

// ── visibleGraph ──────────────────────────────────────────────────────────────

/**
 * Derive the currently visible nodes and edges by applying:
 *   1. Node kind filter  (hiddenNodeKinds)
 *   1b. Hierarchy show/hide  (hiddenPaths — cascade via path prefix)
 *   2. Exclude-pattern filter  (excludePatterns — comma-separated globs)
 *   3a. Grouping mode coercion  (groupByFile / groupByContract / groupByPackage → drop file nodes)
 *   3b. Class grouping coercion  (groupByClass → drop class nodes)
 *   4. Import-node elevation  (import nodes → synthetic `imports` edges)
 *   5. Focus neighbourhood  (focusedNodeId)
 *   6. Edge kind filter  (hiddenEdgeKinds) + endpoint visibility + deduplication
 *
 * Call inside a reactive context (createMemo / createEffect) so SolidJS tracks
 * every state path this reads.
 */
export function visibleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hiddenKindSet = new Set(state.hiddenNodeKinds)
  const hiddenEdgeSet = new Set(state.hiddenEdgeKinds)

  // 1. Apply node kind filter
  let nodes = state.nodes.filter((n) => !hiddenKindSet.has(n.kind))
  let nodeIds = new Set(nodes.map((n) => n.id))

  // 1b. Apply hierarchy show/hide — driven by the HierarchyPanel per-item toggles.
  //     A node disappears if its own ID is hidden, its file path is hidden, or any
  //     directory/package prefix of its file path is hidden.  Parent hiding cascades
  //     to children; un-hiding a parent restores children to their own state.
  if (state.hiddenPaths.length > 0) {
    const hSet = new Set(state.hiddenPaths)
    nodes = nodes.filter((n) => {
      if (hSet.has(n.id)) return false
      const fp = n.filePath
      if (!fp) return true
      const parts = fp.replace(/\\/g, '/').split('/')
      for (let i = 1; i <= parts.length; i++) {
        if (hSet.has(parts.slice(0, i).join('/'))) return false
      }
      return true
    })
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 2. Apply exclude-pattern filter — comma-separated glob patterns matched against filePath.
  //    Each pattern uses `*` as a wildcard; patterns are case-insensitive.
  if (state.excludePatterns.trim()) {
    const regexes = state.excludePatterns
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

  // 3a. When grouping by file, contract, or package, remove file-kind nodes —
  //     they become spatial containers drawn in the canvas layer, not graph nodes.
  if (state.groupByFile || state.groupByContract || state.groupByPackage) {
    nodes = nodes.filter((n) => n.kind !== 'file')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 3b. When grouping by class, remove class-kind nodes — they become spatial
  //     containers holding their method/property children.
  if (state.groupByClass) {
    nodes = nodes.filter((n) => n.kind !== 'class')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 4. Elevate import nodes to direct edges — strip all import-kind nodes from
  //    the visible graph and replace each with synthetic `imports` edges that
  //    connect the containing file/module directly to the import target.
  const syntheticImportEdges: GraphEdge[] = []
  {
    const importIds = new Set<string>()
    for (const n of nodes) {
      if (n.kind === 'import') importIds.add(n.id)
    }

    if (importIds.size > 0) {
      const importContainers = new Map<string, Set<string>>()
      const importTargets = new Map<string, Set<string>>()

      for (const e of state.edges) {
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

  // 5. Apply focus: narrow to focused node + its direct neighbours
  const focusId = state.focusedNodeId
  if (focusId && nodeIds.has(focusId)) {
    const keep = new Set<string>([focusId])
    for (const e of state.edges) {
      if (e.source === focusId && nodeIds.has(e.target)) keep.add(e.target)
      if (e.target === focusId && nodeIds.has(e.source)) keep.add(e.source)
    }
    nodes = nodes.filter((n) => keep.has(n.id))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 6. Filter edges: kind not hidden, both endpoints visible, deduplicated by
  //    (src, tgt, kind). Synthetic import-elevation edges merged in after.
  const seenEdgeKeys = new Set<string>()
  const edges: GraphEdge[] = []

  for (const e of state.edges) {
    if (hiddenEdgeSet.has(e.kind)) continue
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source}|${e.target}|${e.kind}`
    if (seenEdgeKeys.has(key)) continue
    seenEdgeKeys.add(key)
    edges.push(e)
  }

  for (const e of syntheticImportEdges) {
    const key = `${e.source}|${e.target}|${e.kind}`
    if (!seenEdgeKeys.has(key)) {
      seenEdgeKeys.add(key)
      edges.push(e)
    }
  }

  return { nodes, edges }
}
