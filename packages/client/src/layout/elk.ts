import ELK from 'elkjs/lib/elk-api.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js'
// Vite bundles elk-worker.min.js as a separate chunk; the `?worker` suffix
// gives us a constructor whose instances are real Web Workers — ELK layout
// then runs off the main thread entirely.
import ELKWorker from 'elkjs/lib/elk-worker.min.js?worker'
import type { FileGroup, GraphDirection, GraphEdge, GraphNode } from '@graphcoder/core'

const elk = new ELK({ workerFactory: () => new ELKWorker() })

// Below this node count: full layered layout with crossing minimisation.
// At or above: disable crossing minimisation + use simple node placement to
// avoid the O(n²) internal array allocation that throws Invalid array length.
// Lowered from 2000: dense codebases OOM in the worker before the algorithm
// even completes one crossing-minimisation pass.
const LARGE_GRAPH_THRESHOLD = 200

const LAYOUT_OPTIONS: Record<GraphDirection, Record<string, string>> = {
  TB: {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.spacing.nodeNode': '40',
    'elk.layered.spacing.nodeNodeBetweenLayers': '60'
  },
  LR: {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '30',
    'elk.layered.spacing.nodeNodeBetweenLayers': '50'
  }
}

/** Additional ELK options that avoid the O(n²) crossing-minimisation step. */
const LARGE_GRAPH_OVERRIDES: Record<string, string> = {
  'elk.layered.crossingMinimization.strategy': 'NONE',
  'elk.layered.nodePlacement.strategy': 'SIMPLE',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.considerModelOrder.strategy': 'NONE'
}

const NODE_WIDTH = 160
const NODE_HEIGHT = 40

// ── Public types ──────────────────────────────────────────────────────────────

export interface LayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  kind?: string
  sections: Array<{
    startPoint: { x: number; y: number }
    endPoint: { x: number; y: number }
    bendPoints?: Array<{ x: number; y: number }>
  }>
}

// FileGroup is defined in @graphcoder/core and imported at the top of this file.
// It is re-exported here so callers that import from elk.ts continue to work.
export type { FileGroup }

/** A rendered container box returned from a grouped layout. */
export interface FileContainer {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  color?: string
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  /** Primary containers (file-level groups or flat contract/package groups). */
  containers: FileContainer[]
  /** Sub-containers one level inside primary containers (class groups inside file groups). */
  classContainers: FileContainer[]
  /** Directory-level containers — one per unique parent directory of nested groups. */
  dirContainers: FileContainer[]
  /** Package-level containers — outermost tier when groupByPackage + groupByFile are both on. */
  packageContainers: FileContainer[]
  width: number
  height: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEdgeKindMap(edges: GraphEdge[]): Map<string, string> {
  const m = new Map<string, string>()
  edges.forEach((e, i) => m.set(`e${i}`, e.kind))
  return m
}

function extractEdgeSections(
  node: ElkNode,
  edgeKindMap: Map<string, string>,
  out: LayoutEdge[],
  offsetX = 0,
  offsetY = 0
): void {
  for (const edge of node.edges ?? []) {
    const ext = edge as ElkExtendedEdge
    const sections = (ext.sections ?? []).map((s) => ({
      startPoint: { x: s.startPoint.x + offsetX, y: s.startPoint.y + offsetY },
      endPoint: { x: s.endPoint.x + offsetX, y: s.endPoint.y + offsetY },
      bendPoints: s.bendPoints?.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY }))
    }))
    out.push({
      id: ext.id ?? '',
      source: (ext.sources ?? [])[0] ?? '',
      target: (ext.targets ?? [])[0] ?? '',
      kind: edgeKindMap.get(ext.id ?? ''),
      sections
    })
  }
}

// ── Flat layout ───────────────────────────────────────────────────────────────

async function layoutFlat(
  nodes: GraphNode[],
  edges: GraphEdge[],
  direction: GraphDirection,
  nodeIds: Set<string>
): Promise<LayoutResult> {
  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  const edgeKindMap = buildEdgeKindMap(validEdges)

  const elkNodes: ElkNode[] = nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT }))
  const elkEdges: ElkExtendedEdge[] = validEdges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.source],
    targets: [e.target]
  }))

  const baseOpts = LAYOUT_OPTIONS[direction]
  const layoutOptions = nodes.length >= LARGE_GRAPH_THRESHOLD ? { ...baseOpts, ...LARGE_GRAPH_OVERRIDES } : baseOpts

  const graph: ElkNode = {
    id: 'root',
    layoutOptions,
    children: elkNodes,
    edges: elkEdges
  }

  const layouted = await elk.layout(graph)

  const resultNodes = new Map<string, LayoutNode>()
  let maxX = 0,
    maxY = 0

  for (const child of layouted.children ?? []) {
    const x = child.x ?? 0
    const y = child.y ?? 0
    const w = child.width ?? NODE_WIDTH
    const h = child.height ?? NODE_HEIGHT
    resultNodes.set(child.id, { id: child.id, x, y, width: w, height: h })
    if (x + w > maxX) maxX = x + w
    if (y + h > maxY) maxY = y + h
  }

  const resultEdges: LayoutEdge[] = []
  extractEdgeSections(layouted, edgeKindMap, resultEdges)

  return {
    nodes: resultNodes,
    edges: resultEdges,
    containers: [],
    classContainers: [],
    dirContainers: [],
    packageContainers: [],
    width: maxX,
    height: maxY
  }
}

// ── Grouped layout ────────────────────────────────────────────────────────────
//
// Supports three composable grouping modes simultaneously:
//
//   file grouping   (filePath set)    → dir → file → leaf
//   class grouping  (childGroups set) → dir → file → class → leaf
//   contract grouping (no filePath)   → flat root compounds alongside dir compounds
//
// Layout tier is determined by whether nested (filePath-bearing) groups exist
// and how many distinct parent directories they span:
//   0 nested groups              → 2-tier flat (contract groups only)
//   nested, single dir, no flat  → 2-tier flat  (single-dir file project)
//   nested, multi-dir OR any flat alongside nested → 3-tier dir nesting
//
// Edge routing: LCA-based placement at file/dir/root level so ELK routes
// edges correctly within each compound. Flat group edges go at root level.
// elk.hierarchyHandling: INCLUDE_CHILDREN on root + dir nodes for cross-compound routing.

function parentDir(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i > 0 ? filePath.slice(0, i) : '.'
}

function dirLabel(dirPath: string): string {
  if (dirPath === '.') return '/'
  const parts = dirPath.split('/').filter(Boolean)
  return '/' + parts.slice(-2).join('/')
}

async function layoutGrouped(
  nodes: GraphNode[],
  edges: GraphEdge[],
  direction: GraphDirection,
  fileGroups: FileGroup[],
  nodeIds: Set<string>
): Promise<LayoutResult> {
  const isLarge = nodes.length >= LARGE_GRAPH_THRESHOLD
  // ── Build group registry ──────────────────────────────────────────────────

  // All top-level groups (fileGroups param) and their sub-groups.
  const topGroupMap = new Map<string, FileGroup>() // id → top-level group
  const subGroupMap = new Map<string, FileGroup>() // id → sub-group (childGroup)

  // For each leaf node: which top-level group and (optionally) which sub-group contains it?
  const nodeToTopGroup = new Map<string, string>() // nodeId → topGroup id
  const nodeToSubGroup = new Map<string, string>() // nodeId → subGroup id

  for (const fg of fileGroups) {
    topGroupMap.set(fg.id, fg)
    for (const cid of fg.childIds) {
      if (nodeIds.has(cid)) nodeToTopGroup.set(cid, fg.id)
    }
    for (const sg of fg.childGroups ?? []) {
      subGroupMap.set(sg.id, sg)
      for (const cid of sg.childIds) {
        if (nodeIds.has(cid)) {
          nodeToTopGroup.set(cid, fg.id)
          nodeToSubGroup.set(cid, sg.id)
        }
      }
    }
  }

  // ── Classify groups: flat (no filePath) vs nested (with filePath) ─────────

  const flatGroups = fileGroups.filter((fg) => !fg.filePath)
  const nestedGroups = fileGroups.filter((fg) => fg.filePath)

  // Group nested file groups by parent directory
  const dirPathToFiles = new Map<string, FileGroup[]>()
  for (const fg of nestedGroups) {
    const dir = parentDir(fg.filePath!)
    if (!dirPathToFiles.has(dir)) dirPathToFiles.set(dir, [])
    dirPathToFiles.get(dir)!.push(fg)
  }

  // ── Shared setup ──────────────────────────────────────────────────────────

  // Valid edge endpoints: layout nodes + group container IDs.
  // Collapsed group containers are leaf-sized ELK nodes (no children) but still
  // appear in the ELK graph, so promoted edges connecting them must pass this filter.
  const groupContainerIds = new Set<string>()
  for (const fg of fileGroups) {
    groupContainerIds.add(fg.id)
    for (const sg of fg.childGroups ?? []) groupContainerIds.add(sg.id)
  }
  const isValidEndpoint = (id: string) => nodeIds.has(id) || groupContainerIds.has(id)
  const validEdges = edges.filter((e) => isValidEndpoint(e.source) && isValidEndpoint(e.target))
  const edgeKindMap = new Map<string, string>()
  validEdges.forEach((e, i) => edgeKindMap.set(`e${i}`, e.kind))

  const rootDir = LAYOUT_OPTIONS[direction]['elk.direction'] ?? 'RIGHT'
  const perpDir = rootDir === 'RIGHT' || rootDir === 'LEFT' ? 'DOWN' : 'RIGHT'

  // Nodes that don't belong to any group: rendered flat at root level
  const ungroupedFlatNodes: ElkNode[] = nodes
    .filter((n) => !nodeToTopGroup.has(n.id))
    .map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT }))

  // ── Determine layout tier ─────────────────────────────────────────────────
  //
  // Use 4-tier (package → dir → file → node) when any nested group carries packagePath.
  // Use 3-tier (dir → group → node) when:
  //   - ≥2 meaningful dirs exist among nested groups, OR
  //   - flat groups and nested groups coexist (contract + file together)
  // Otherwise use 2-tier (all groups as direct root compounds).

  const meaningfulDirCount = [...dirPathToFiles.keys()].filter((dp) => dp !== '.').length
  const usePackageTier = nestedGroups.some((fg) => fg.packagePath)
  const useThreeTier = meaningfulDirCount >= 2 || (flatGroups.length > 0 && nestedGroups.length > 0)

  // ── Package mappings (only needed for 4-tier) ─────────────────────────────

  let packagePathToId = new Map<string, string>()
  let packageIdToLabel = new Map<string, string>()
  let packageIdSet = new Set<string>()
  let fileIdToPackageId = new Map<string, string>() // fileGroup id → pkgCompound id

  if (usePackageTier) {
    let pkgIdx = 0
    for (const fg of nestedGroups) {
      if (fg.packagePath && !packagePathToId.has(fg.packagePath)) {
        const id = `__pkg${pkgIdx++}`
        packagePathToId.set(fg.packagePath, id)
        packageIdToLabel.set(id, fg.packagePath.split('/').pop() ?? fg.packagePath)
      }
    }
    for (const fg of nestedGroups) {
      if (fg.packagePath) {
        fileIdToPackageId.set(fg.id, packagePathToId.get(fg.packagePath)!)
      }
    }
    packageIdSet = new Set(packageIdToLabel.keys())
  }

  // ── Dir compound IDs (shared: used by 3-tier AND 4-tier paths) ───────────
  // Stable ELK-safe ids for directory compounds (paths contain slashes).

  let dirIdx = 0
  const dirPathToId = new Map<string, string>()
  const dirIdToPath = new Map<string, string>()
  for (const dp of dirPathToFiles.keys()) {
    const id = `__dir${dirIdx++}`
    dirPathToId.set(dp, id)
    dirIdToPath.set(id, dp)
  }
  const dirIdSet = new Set(dirIdToPath.keys())

  const fileIdToDirId = new Map<string, string>() // top-level file group id → dir compound id
  for (const [dp, fgs] of dirPathToFiles) {
    const dirId = dirPathToId.get(dp)!
    for (const fg of fgs) fileIdToDirId.set(fg.id, dirId)
  }

  // ── Helper: build a file-level ELK compound node (handles childGroups) ────

  function buildFileElkNode(fg: FileGroup, innerDir: string): ElkNode | null {
    const leafChildren: ElkNode[] = fg.childIds
      .filter((id) => nodeIds.has(id))
      .map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT }))

    const subGroupElkNodes: ElkNode[] = []
    for (const sg of fg.childGroups ?? []) {
      const sgLeaves = sg.childIds.filter((id) => nodeIds.has(id))
      if (sgLeaves.length === 0) continue
      subGroupElkNodes.push({
        id: sg.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': innerDir,
          ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
          'elk.padding': '[top=28,left=8,bottom=8,right=8]',
          'elk.spacing.nodeNode': '16',
          'elk.layered.spacing.nodeNodeBetweenLayers': '20'
        },
        children: sgLeaves.map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT }))
      })
    }

    const allChildren = [...leafChildren, ...subGroupElkNodes]
    if (allChildren.length === 0) {
      if (fg.collapsed) {
        // Collapsed container: no children, but the node must still appear in ELK
        // so that promoted edges (child → container) can be routed to it.
        // A plain leaf node of fixed size achieves this — the renderer still
        // displays it as a container box (it's in topGroupMap).
        return { id: fg.id, width: NODE_WIDTH * 2, height: NODE_HEIGHT }
      }
      return null // Genuinely empty expanded group — skip
    }

    return {
      id: fg.id,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': innerDir,
        ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
        'elk.padding': '[top=36,left=10,bottom=10,right=10]',
        'elk.spacing.nodeNode': '20',
        'elk.layered.spacing.nodeNodeBetweenLayers': '30'
      },
      children: allChildren
    }
  }

  // ── Helper: extract positions from a file-level ELK compound ─────────────

  function extractFileGroupPositions(
    elkFileNode: ElkNode,
    absX: number,
    absY: number,
    outNodes: Map<string, LayoutNode>,
    outClassContainers: FileContainer[]
  ): void {
    for (const child of elkFileNode.children ?? []) {
      const cx = absX + (child.x ?? 0)
      const cy = absY + (child.y ?? 0)
      const cw = child.width ?? NODE_WIDTH
      const ch = child.height ?? NODE_HEIGHT

      if (subGroupMap.has(child.id)) {
        // Sub-group compound (class container)
        const sg = subGroupMap.get(child.id)!
        outClassContainers.push({
          id: child.id,
          label: sg.label,
          color: sg.color,
          x: cx,
          y: cy,
          width: cw,
          height: ch
        })
        // Leaf nodes inside the sub-group
        for (const leaf of child.children ?? []) {
          outNodes.set(leaf.id, {
            id: leaf.id,
            x: cx + (leaf.x ?? 0),
            y: cy + (leaf.y ?? 0),
            width: leaf.width ?? NODE_WIDTH,
            height: leaf.height ?? NODE_HEIGHT
          })
        }
      } else {
        // Leaf node directly in the file group
        outNodes.set(child.id, { id: child.id, x: cx, y: cy, width: cw, height: ch })
      }
    }
  }

  // ── Helper: extract edge sections from a file group and its sub-groups ────

  function extractFileGroupEdges(
    elkFileNode: ElkNode,
    absX: number,
    absY: number,
    edgeKindMap: Map<string, string>,
    out: LayoutEdge[]
  ): void {
    if (elkFileNode.edges?.length) {
      extractEdgeSections(elkFileNode, edgeKindMap, out, absX, absY)
    }
    // Sub-group level edges (within a class container)
    for (const child of elkFileNode.children ?? []) {
      if (subGroupMap.has(child.id) && child.edges?.length) {
        extractEdgeSections(child, edgeKindMap, out, absX + (child.x ?? 0), absY + (child.y ?? 0))
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2-TIER FLAT LAYOUT
  // All groups (flat contract + single-dir nested) as direct root compounds.
  // ─────────────────────────────────────────────────────────────────────────

  if (!useThreeTier && !usePackageTier) {
    // Edge classification: same-group → group edge map, else → root
    const groupEdgeMap = new Map<string, ElkExtendedEdge[]>()
    const rootEdges2: ElkExtendedEdge[] = []

    validEdges.forEach((e, i) => {
      const id = `e${i}`
      const elk_edge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }
      const srcGroup = nodeToTopGroup.get(e.source)
      const tgtGroup = nodeToTopGroup.get(e.target)
      if (srcGroup !== undefined && srcGroup === tgtGroup) {
        if (!groupEdgeMap.has(srcGroup)) groupEdgeMap.set(srcGroup, [])
        groupEdgeMap.get(srcGroup)!.push(elk_edge)
      } else {
        rootEdges2.push(elk_edge)
      }
    })

    // Build all groups as root-level ELK compounds
    const groupElkNodes: ElkNode[] = []
    for (const fg of fileGroups) {
      const n = buildFileElkNode(fg, rootDir)
      if (!n) continue
      const fe = groupEdgeMap.get(fg.id)
      if (fe?.length) n.edges = fe
      groupElkNodes.push(n)
    }

    const flat2Graph: ElkNode = {
      id: 'root',
      layoutOptions: {
        ...LAYOUT_OPTIONS[direction],
        ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80'
      },
      children: [...groupElkNodes, ...ungroupedFlatNodes],
      edges: rootEdges2
    }

    const flat2Layouted = await elk.layout(flat2Graph)

    const flat2Nodes = new Map<string, LayoutNode>()
    const flat2Containers: FileContainer[] = []
    const flat2ClassContainers: FileContainer[] = []
    let flat2MaxX = 0,
      flat2MaxY = 0

    for (const child of flat2Layouted.children ?? []) {
      const cx = child.x ?? 0
      const cy = child.y ?? 0
      const cw = child.width ?? NODE_WIDTH
      const ch = child.height ?? NODE_HEIGHT

      if (topGroupMap.has(child.id)) {
        const fg = topGroupMap.get(child.id)!
        flat2Containers.push({ id: child.id, label: fg.label, color: fg.color, x: cx, y: cy, width: cw, height: ch })
        extractFileGroupPositions(child, cx, cy, flat2Nodes, flat2ClassContainers)
      } else {
        flat2Nodes.set(child.id, { id: child.id, x: cx, y: cy, width: cw, height: ch })
      }

      if (cx + cw > flat2MaxX) flat2MaxX = cx + cw
      if (cy + ch > flat2MaxY) flat2MaxY = cy + ch
    }

    const flat2Edges: LayoutEdge[] = []
    extractEdgeSections(flat2Layouted, edgeKindMap, flat2Edges)
    for (const child of flat2Layouted.children ?? []) {
      if (topGroupMap.has(child.id)) {
        extractFileGroupEdges(child, child.x ?? 0, child.y ?? 0, edgeKindMap, flat2Edges)
      }
    }

    return {
      nodes: flat2Nodes,
      edges: flat2Edges,
      containers: flat2Containers,
      classContainers: flat2ClassContainers,
      dirContainers: [],
      packageContainers: [],
      width: flat2MaxX,
      height: flat2MaxY
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4-TIER PACKAGE LAYOUT
  // root → [package compounds → dir compounds → file compounds → (class →) nodes]
  //      → flat contract groups (no package wrapping)
  //      → ungrouped flat nodes
  //
  // Edge routing: same-file → file, same-dir → dir, same-package diff-dir → package,
  // otherwise → root. Flat group edges stay at flat group level.
  // ─────────────────────────────────────────────────────────────────────────

  if (usePackageTier) {
    const pkg4RootEdges: ElkExtendedEdge[] = []
    const pkg4PackageEdgeMap = new Map<string, ElkExtendedEdge[]>()
    const pkg4DirEdgeMap = new Map<string, ElkExtendedEdge[]>()
    const pkg4FileEdgeMap = new Map<string, ElkExtendedEdge[]>()
    const pkg4FlatEdgeMap = new Map<string, ElkExtendedEdge[]>()

    validEdges.forEach((e, i) => {
      const id = `e${i}`
      const elk_edge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }
      const srcTop = nodeToTopGroup.get(e.source)
      const tgtTop = nodeToTopGroup.get(e.target)

      if (srcTop !== undefined && srcTop === tgtTop) {
        const fg = topGroupMap.get(srcTop)!
        if (fg.filePath) {
          if (!pkg4FileEdgeMap.has(srcTop)) pkg4FileEdgeMap.set(srcTop, [])
          pkg4FileEdgeMap.get(srcTop)!.push(elk_edge)
        } else {
          if (!pkg4FlatEdgeMap.has(srcTop)) pkg4FlatEdgeMap.set(srcTop, [])
          pkg4FlatEdgeMap.get(srcTop)!.push(elk_edge)
        }
      } else if (srcTop !== undefined && tgtTop !== undefined) {
        const srcFg = topGroupMap.get(srcTop)!
        const tgtFg = topGroupMap.get(tgtTop)!
        if (srcFg.filePath && tgtFg.filePath) {
          const srcDirId = fileIdToDirId.get(srcTop)
          const tgtDirId = fileIdToDirId.get(tgtTop)
          if (srcDirId && tgtDirId && srcDirId === tgtDirId) {
            if (!pkg4DirEdgeMap.has(srcDirId)) pkg4DirEdgeMap.set(srcDirId, [])
            pkg4DirEdgeMap.get(srcDirId)!.push(elk_edge)
          } else {
            const srcPkgId = fileIdToPackageId.get(srcTop)
            const tgtPkgId = fileIdToPackageId.get(tgtTop)
            if (srcPkgId && tgtPkgId && srcPkgId === tgtPkgId) {
              if (!pkg4PackageEdgeMap.has(srcPkgId)) pkg4PackageEdgeMap.set(srcPkgId, [])
              pkg4PackageEdgeMap.get(srcPkgId)!.push(elk_edge)
            } else {
              pkg4RootEdges.push(elk_edge)
            }
          }
        } else {
          pkg4RootEdges.push(elk_edge)
        }
      } else {
        pkg4RootEdges.push(elk_edge)
      }
    })

    // Build file ELK compounds (same helper as 3-tier)
    const pkg4FileElkMap = new Map<string, ElkNode>()
    for (const fg of nestedGroups) {
      const n = buildFileElkNode(fg, rootDir)
      if (!n) continue
      const fe = pkg4FileEdgeMap.get(fg.id)
      if (fe?.length) n.edges = fe
      pkg4FileElkMap.set(fg.id, n)
    }

    // Build dir ELK compounds (per package — may share dir IDs across packages if dirs differ)
    const pkg4DirElkMap = new Map<string, ElkNode>() // dirId → ElkNode
    for (const [dp, fgs] of dirPathToFiles) {
      const dirId = dirPathToId.get(dp)!
      const children = fgs.map((fg) => pkg4FileElkMap.get(fg.id)).filter((n): n is ElkNode => n !== undefined)
      if (children.length === 0) continue
      const dn: ElkNode = {
        id: dirId,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': perpDir,
          ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.padding': '[top=30,left=12,bottom=12,right=12]',
          'elk.spacing.nodeNode': '30',
          'elk.layered.spacing.nodeNodeBetweenLayers': '40'
        },
        children
      }
      const de = pkg4DirEdgeMap.get(dirId)
      if (de?.length) dn.edges = de
      pkg4DirElkMap.set(dirId, dn)
    }

    // Build package ELK compounds, each containing its dir compounds
    // Group dirs by package: packageId → dirIds
    const pkgIdToDirIds = new Map<string, string[]>()
    for (const [dp, fgs] of dirPathToFiles) {
      const dirId = dirPathToId.get(dp)!
      // Determine package from first file group in this dir
      const pkgPath = fgs[0]?.packagePath
      if (!pkgPath) continue // dir without package stays unpacked (added at root below)
      const pkgId = packagePathToId.get(pkgPath)!
      if (!pkgIdToDirIds.has(pkgId)) pkgIdToDirIds.set(pkgId, [])
      pkgIdToDirIds.get(pkgId)!.push(dirId)
    }

    const pkg4PackageElkNodes: ElkNode[] = []
    for (const [pkgId, dirIds] of pkgIdToDirIds) {
      const children = dirIds.map((did) => pkg4DirElkMap.get(did)).filter((n): n is ElkNode => n !== undefined)
      if (children.length === 0) continue
      const pn: ElkNode = {
        id: pkgId,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': perpDir,
          ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.padding': '[top=44,left=18,bottom=18,right=18]',
          'elk.spacing.nodeNode': '40',
          'elk.layered.spacing.nodeNodeBetweenLayers': '60'
        },
        children
      }
      const pe = pkg4PackageEdgeMap.get(pkgId)
      if (pe?.length) pn.edges = pe
      pkg4PackageElkNodes.push(pn)
    }

    // Dirs not assigned to any package sit at root alongside package compounds
    const pkg4UnpackedDirElkNodes: ElkNode[] = []
    for (const [dp, _fgs] of dirPathToFiles) {
      const dirId = dirPathToId.get(dp)!
      const pkgPath = _fgs[0]?.packagePath
      if (!pkgPath) {
        const dn = pkg4DirElkMap.get(dirId)
        if (dn) pkg4UnpackedDirElkNodes.push(dn)
      }
    }

    // Flat contract groups at root (same as 3-tier)
    const pkg4FlatElkNodes: ElkNode[] = []
    for (const fg of flatGroups) {
      const n = buildFileElkNode(fg, rootDir)
      if (!n) continue
      const fe = pkg4FlatEdgeMap.get(fg.id)
      if (fe?.length) n.edges = fe
      pkg4FlatElkNodes.push(n)
    }

    const pkg4Graph: ElkNode = {
      id: 'root',
      layoutOptions: {
        ...LAYOUT_OPTIONS[direction],
        ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.spacing.nodeNode': '100',
        'elk.layered.spacing.nodeNodeBetweenLayers': '120'
      },
      children: [...pkg4PackageElkNodes, ...pkg4UnpackedDirElkNodes, ...pkg4FlatElkNodes, ...ungroupedFlatNodes],
      edges: pkg4RootEdges
    }

    const pkg4Layouted = await elk.layout(pkg4Graph)

    // ── Extract positions ───────────────────────────────────────────────────

    const pkg4Nodes = new Map<string, LayoutNode>()
    const pkg4Containers: FileContainer[] = []
    const pkg4ClassContainers: FileContainer[] = []
    const pkg4DirContainers: FileContainer[] = []
    const pkg4PkgContainers: FileContainer[] = []
    let pkg4MaxX = 0
    let pkg4MaxY = 0

    for (const rootChild of pkg4Layouted.children ?? []) {
      const rx = rootChild.x ?? 0
      const ry = rootChild.y ?? 0
      const rw = rootChild.width ?? NODE_WIDTH
      const rh = rootChild.height ?? NODE_HEIGHT
      if (rx + rw > pkg4MaxX) pkg4MaxX = rx + rw
      if (ry + rh > pkg4MaxY) pkg4MaxY = ry + rh

      if (packageIdSet.has(rootChild.id)) {
        // Package compound
        const pkgLabel = packageIdToLabel.get(rootChild.id)!
        pkg4PkgContainers.push({ id: rootChild.id, label: pkgLabel, x: rx, y: ry, width: rw, height: rh })

        for (const dirChild of rootChild.children ?? []) {
          const dx = rx + (dirChild.x ?? 0)
          const dy = ry + (dirChild.y ?? 0)
          const dw = dirChild.width ?? NODE_WIDTH
          const dh = dirChild.height ?? NODE_HEIGHT

          if (dirIdSet.has(dirChild.id)) {
            const dp = dirIdToPath.get(dirChild.id)!
            pkg4DirContainers.push({ id: dirChild.id, label: dirLabel(dp), x: dx, y: dy, width: dw, height: dh })

            for (const fileChild of dirChild.children ?? []) {
              const fx = dx + (fileChild.x ?? 0)
              const fy = dy + (fileChild.y ?? 0)
              const fw = fileChild.width ?? NODE_WIDTH
              const fh = fileChild.height ?? NODE_HEIGHT

              if (topGroupMap.has(fileChild.id)) {
                const fg = topGroupMap.get(fileChild.id)!
                pkg4Containers.push({ id: fileChild.id, label: fg.label, x: fx, y: fy, width: fw, height: fh })
                extractFileGroupPositions(fileChild, fx, fy, pkg4Nodes, pkg4ClassContainers)
              } else {
                pkg4Nodes.set(fileChild.id, { id: fileChild.id, x: fx, y: fy, width: fw, height: fh })
              }
            }
          }
        }
      } else if (dirIdSet.has(rootChild.id)) {
        // Unpacked dir at root (no package)
        const dp = dirIdToPath.get(rootChild.id)!
        pkg4DirContainers.push({ id: rootChild.id, label: dirLabel(dp), x: rx, y: ry, width: rw, height: rh })
        for (const fileChild of rootChild.children ?? []) {
          const fx = rx + (fileChild.x ?? 0)
          const fy = ry + (fileChild.y ?? 0)
          const fw = fileChild.width ?? NODE_WIDTH
          const fh = fileChild.height ?? NODE_HEIGHT
          if (topGroupMap.has(fileChild.id)) {
            const fg = topGroupMap.get(fileChild.id)!
            pkg4Containers.push({ id: fileChild.id, label: fg.label, x: fx, y: fy, width: fw, height: fh })
            extractFileGroupPositions(fileChild, fx, fy, pkg4Nodes, pkg4ClassContainers)
          } else {
            pkg4Nodes.set(fileChild.id, { id: fileChild.id, x: fx, y: fy, width: fw, height: fh })
          }
        }
      } else if (topGroupMap.has(rootChild.id)) {
        // Flat contract group at root
        const fg = topGroupMap.get(rootChild.id)!
        pkg4Containers.push({ id: rootChild.id, label: fg.label, color: fg.color, x: rx, y: ry, width: rw, height: rh })
        extractFileGroupPositions(rootChild, rx, ry, pkg4Nodes, pkg4ClassContainers)
      } else {
        // Ungrouped flat node
        pkg4Nodes.set(rootChild.id, { id: rootChild.id, x: rx, y: ry, width: rw, height: rh })
      }
    }

    // ── Extract edges ───────────────────────────────────────────────────────

    const pkg4Edges: LayoutEdge[] = []
    extractEdgeSections(pkg4Layouted, edgeKindMap, pkg4Edges) // root-level

    for (const rootChild of pkg4Layouted.children ?? []) {
      const rx = rootChild.x ?? 0
      const ry = rootChild.y ?? 0

      if (packageIdSet.has(rootChild.id)) {
        if (rootChild.edges?.length) extractEdgeSections(rootChild, edgeKindMap, pkg4Edges, rx, ry)
        for (const dirChild of rootChild.children ?? []) {
          const dx = rx + (dirChild.x ?? 0)
          const dy = ry + (dirChild.y ?? 0)
          if (dirIdSet.has(dirChild.id)) {
            if (dirChild.edges?.length) extractEdgeSections(dirChild, edgeKindMap, pkg4Edges, dx, dy)
            for (const fileChild of dirChild.children ?? []) {
              if (topGroupMap.has(fileChild.id)) {
                extractFileGroupEdges(
                  fileChild,
                  dx + (fileChild.x ?? 0),
                  dy + (fileChild.y ?? 0),
                  edgeKindMap,
                  pkg4Edges
                )
              }
            }
          }
        }
      } else if (dirIdSet.has(rootChild.id)) {
        if (rootChild.edges?.length) extractEdgeSections(rootChild, edgeKindMap, pkg4Edges, rx, ry)
        for (const fileChild of rootChild.children ?? []) {
          if (topGroupMap.has(fileChild.id)) {
            extractFileGroupEdges(fileChild, rx + (fileChild.x ?? 0), ry + (fileChild.y ?? 0), edgeKindMap, pkg4Edges)
          }
        }
      } else if (topGroupMap.has(rootChild.id)) {
        extractFileGroupEdges(rootChild, rx, ry, edgeKindMap, pkg4Edges)
      }
    }

    return {
      nodes: pkg4Nodes,
      edges: pkg4Edges,
      containers: pkg4Containers,
      classContainers: pkg4ClassContainers,
      dirContainers: pkg4DirContainers,
      packageContainers: pkg4PkgContainers,
      width: pkg4MaxX,
      height: pkg4MaxY
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3-TIER NESTED LAYOUT
  // root → [dir compounds] → file compounds → (class compounds →) leaf nodes
  //      → flat group compounds (contract groups, no dir wrapping)
  //
  // Edges placed at LCA level:
  //   same file group → file compound edges
  //   same dir, diff file → dir compound edges
  //   flat-group-internal → flat group compound edges
  //   everything else → root edges
  // ─────────────────────────────────────────────────────────────────────────

  // ── Classify edges by LCA level ───────────────────────────────────────────

  const rootEdges: ElkExtendedEdge[] = []
  const dirEdgeMap = new Map<string, ElkExtendedEdge[]>()
  const fileEdgeMap = new Map<string, ElkExtendedEdge[]>()
  const flatGroupEdgeMap = new Map<string, ElkExtendedEdge[]>()

  validEdges.forEach((e, i) => {
    const id = `e${i}`
    const elk_edge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }

    const srcTopGroup = nodeToTopGroup.get(e.source)
    const tgtTopGroup = nodeToTopGroup.get(e.target)

    if (srcTopGroup !== undefined && srcTopGroup === tgtTopGroup) {
      // Same top-level group
      const fg = topGroupMap.get(srcTopGroup)!
      if (fg.filePath) {
        // File group internal edge
        if (!fileEdgeMap.has(srcTopGroup)) fileEdgeMap.set(srcTopGroup, [])
        fileEdgeMap.get(srcTopGroup)!.push(elk_edge)
      } else {
        // Flat group (contract) internal edge
        if (!flatGroupEdgeMap.has(srcTopGroup)) flatGroupEdgeMap.set(srcTopGroup, [])
        flatGroupEdgeMap.get(srcTopGroup)!.push(elk_edge)
      }
    } else if (srcTopGroup !== undefined && tgtTopGroup !== undefined) {
      const srcFg = topGroupMap.get(srcTopGroup)!
      const tgtFg = topGroupMap.get(tgtTopGroup)!
      // Both in nested file groups → check if same dir
      if (srcFg.filePath && tgtFg.filePath) {
        const srcDirId = fileIdToDirId.get(srcTopGroup)
        const tgtDirId = fileIdToDirId.get(tgtTopGroup)
        if (srcDirId && tgtDirId && srcDirId === tgtDirId) {
          if (!dirEdgeMap.has(srcDirId)) dirEdgeMap.set(srcDirId, [])
          dirEdgeMap.get(srcDirId)!.push(elk_edge)
        } else {
          rootEdges.push(elk_edge)
        }
      } else {
        // One or both in flat groups, or mixed — root level
        rootEdges.push(elk_edge)
      }
    } else {
      rootEdges.push(elk_edge)
    }
  })

  // ── Build file compound ELK nodes ─────────────────────────────────────────

  const fileElkNodeMap = new Map<string, ElkNode>()
  for (const fg of nestedGroups) {
    const n = buildFileElkNode(fg, rootDir)
    if (!n) continue
    const fe = fileEdgeMap.get(fg.id)
    if (fe?.length) n.edges = fe
    fileElkNodeMap.set(fg.id, n)
  }

  // ── Build flat group ELK nodes (contract groups — direct root compounds) ──

  const flatGroupElkNodes: ElkNode[] = []
  for (const fg of flatGroups) {
    const n = buildFileElkNode(fg, rootDir)
    if (!n) continue
    const fe = flatGroupEdgeMap.get(fg.id)
    if (fe?.length) n.edges = fe
    flatGroupElkNodes.push(n)
  }

  // ── Build dir compound ELK nodes ──────────────────────────────────────────

  const dirElkNodes: ElkNode[] = []
  for (const [dp, fgs] of dirPathToFiles) {
    const dirId = dirPathToId.get(dp)!
    const children = fgs.map((fg) => fileElkNodeMap.get(fg.id)).filter((n): n is ElkNode => n !== undefined)
    if (children.length === 0) continue

    const dn: ElkNode = {
      id: dirId,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': perpDir,
        ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.padding': '[top=30,left=12,bottom=12,right=12]',
        'elk.spacing.nodeNode': '30',
        'elk.layered.spacing.nodeNodeBetweenLayers': '40'
      },
      children
    }
    const de = dirEdgeMap.get(dirId)
    if (de?.length) dn.edges = de
    dirElkNodes.push(dn)
  }

  // ── Build root graph ──────────────────────────────────────────────────────

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...LAYOUT_OPTIONS[direction],
      ...(isLarge ? LARGE_GRAPH_OVERRIDES : {}),
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100'
    },
    children: [...dirElkNodes, ...flatGroupElkNodes, ...ungroupedFlatNodes],
    edges: rootEdges
  }

  const layouted = await elk.layout(graph)

  // ── Extract positions ─────────────────────────────────────────────────────

  const resultNodes = new Map<string, LayoutNode>()
  const containers: FileContainer[] = []
  const classContainers: FileContainer[] = []
  const dirContainers: FileContainer[] = []
  let maxX = 0,
    maxY = 0

  for (const rootChild of layouted.children ?? []) {
    const rx = rootChild.x ?? 0
    const ry = rootChild.y ?? 0
    const rw = rootChild.width ?? NODE_WIDTH
    const rh = rootChild.height ?? NODE_HEIGHT

    if (dirIdSet.has(rootChild.id)) {
      // Directory compound
      const dp = dirIdToPath.get(rootChild.id)!
      dirContainers.push({ id: rootChild.id, label: dirLabel(dp), x: rx, y: ry, width: rw, height: rh })

      for (const fileChild of rootChild.children ?? []) {
        const fx = rx + (fileChild.x ?? 0)
        const fy = ry + (fileChild.y ?? 0)
        const fw = fileChild.width ?? NODE_WIDTH
        const fh = fileChild.height ?? NODE_HEIGHT

        if (topGroupMap.has(fileChild.id)) {
          const fg = topGroupMap.get(fileChild.id)!
          containers.push({ id: fileChild.id, label: fg.label, x: fx, y: fy, width: fw, height: fh })
          extractFileGroupPositions(fileChild, fx, fy, resultNodes, classContainers)
        } else {
          // Ungrouped node inside dir (shouldn't happen but handle gracefully)
          resultNodes.set(fileChild.id, { id: fileChild.id, x: fx, y: fy, width: fw, height: fh })
        }
      }
    } else if (topGroupMap.has(rootChild.id)) {
      // Flat group compound at root level (contract group)
      const fg = topGroupMap.get(rootChild.id)!
      containers.push({ id: rootChild.id, label: fg.label, color: fg.color, x: rx, y: ry, width: rw, height: rh })
      extractFileGroupPositions(rootChild, rx, ry, resultNodes, classContainers)
    } else {
      // Ungrouped flat node
      resultNodes.set(rootChild.id, { id: rootChild.id, x: rx, y: ry, width: rw, height: rh })
    }

    if (rx + rw > maxX) maxX = rx + rw
    if (ry + rh > maxY) maxY = ry + rh
  }

  // ── Extract edge sections ─────────────────────────────────────────────────

  const resultEdges: LayoutEdge[] = []

  // Root-level cross-dir edges
  extractEdgeSections(layouted, edgeKindMap, resultEdges)

  for (const rootChild of layouted.children ?? []) {
    const rx = rootChild.x ?? 0
    const ry = rootChild.y ?? 0

    if (dirIdSet.has(rootChild.id)) {
      // Dir-level same-dir edges
      if (rootChild.edges?.length) {
        extractEdgeSections(rootChild, edgeKindMap, resultEdges, rx, ry)
      }
      // File-level edges + sub-group edges
      for (const fileChild of rootChild.children ?? []) {
        if (topGroupMap.has(fileChild.id)) {
          extractFileGroupEdges(fileChild, rx + (fileChild.x ?? 0), ry + (fileChild.y ?? 0), edgeKindMap, resultEdges)
        }
      }
    } else if (topGroupMap.has(rootChild.id)) {
      // Flat group (contract) edges
      extractFileGroupEdges(rootChild, rx, ry, edgeKindMap, resultEdges)
    }
  }

  return {
    nodes: resultNodes,
    edges: resultEdges,
    containers,
    classContainers,
    dirContainers,
    packageContainers: [],
    width: maxX,
    height: maxY
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run ELK layout. When fileGroups is provided the layout uses compound nodes
 * so grouped nodes are spatially co-located. All three grouping modes
 * (file, class, contract) compose freely via the FileGroup structure.
 */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  direction: GraphDirection,
  fileGroups?: FileGroup[]
): Promise<LayoutResult> {
  const nodeIds = new Set(nodes.map((n) => n.id))

  if (fileGroups && fileGroups.length > 0) {
    return layoutGrouped(nodes, edges, direction, fileGroups, nodeIds)
  }

  return layoutFlat(nodes, edges, direction, nodeIds)
}
