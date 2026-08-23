import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { GraphEdge, GraphNode, ViewMode } from '@graphcoder/core'

const elk = new ELK()

const LAYOUT_OPTIONS: Record<ViewMode, Record<string, string>> = {
  'module-dependency': {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.spacing.nodeNode': '40',
    'elk.layered.spacing.nodeNodeBetweenLayers': '60'
  },
  'call-graph': {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '30',
    'elk.layered.spacing.nodeNodeBetweenLayers': '50'
  },
  'impact-radius': {
    'elk.algorithm': 'mrtree',
    'elk.spacing.nodeNode': '40'
  }
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

/** A file group fed to layoutGraph to enable compound-node layout. */
export interface FileGroup {
  /** The file node's id — becomes the ELK compound node id. */
  id: string
  /** Display label for the container box (typically the filename). */
  label: string
  /** Ids of child nodes currently visible — these become ELK children. */
  childIds: string[]
  /**
   * Full file path — used to compute directory grouping.
   * When omitted the file is placed in a synthetic "root" directory.
   */
  filePath?: string
  /**
   * Optional accent color (CSS hex string, e.g. '#10b981') used to distinguish
   * contract groups from plain file groups. Passed through to the rendered
   * FileContainer so the canvas can draw a coloured border.
   */
  color?: string
}

/** A rendered container box returned from a grouped layout. */
export interface FileContainer {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  /** Optional accent color inherited from the FileGroup (contract groups only). */
  color?: string
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  /** File-level containers. Non-empty only when layoutGraph was called with fileGroups. */
  containers: FileContainer[]
  /** Directory-level containers — one per unique parent directory of the file groups. */
  dirContainers: FileContainer[]
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

// ── Flat layout (current behaviour) ──────────────────────────────────────────

async function layoutFlat(
  nodes: GraphNode[],
  edges: GraphEdge[],
  viewMode: ViewMode,
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

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS[viewMode],
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

  return { nodes: resultNodes, edges: resultEdges, containers: [], dirContainers: [], width: maxX, height: maxY }
}

// ── Grouped layout (directory → file → node compound nesting) ─────────────────
//
// Three levels of ELK compound nodes:
//   root  →  dir compounds  →  file compounds  →  leaf nodes
//
// Edges are placed at their Lowest Common Ancestor (LCA) container so ELK
// routes them correctly at each level:
//   same file      → file compound's .edges
//   same dir, diff file → dir compound's .edges
//   diff dir (or ungrouped) → root's .edges
//
// elk.hierarchyHandling: INCLUDE_CHILDREN is set on root and on each dir
// compound so ELK can route edges whose endpoints live inside nested children.
//
// Alternating layout directions at each level maximises 2D space usage:
//   root  → primary direction (matches view mode)
//   dir   → perpendicular direction  (cross-axis organisation)
//   file  → primary direction again

function parentDir(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i > 0 ? filePath.slice(0, i) : '.'
}

function dirLabel(dirPath: string): string {
  if (dirPath === '.') return '/'
  const parts = dirPath.split('/').filter(Boolean)
  // Show last two components: enough context, no long absolute prefixes
  return '/' + parts.slice(-2).join('/')
}

async function layoutGrouped(
  nodes: GraphNode[],
  edges: GraphEdge[],
  viewMode: ViewMode,
  fileGroups: FileGroup[],
  nodeIds: Set<string>
): Promise<LayoutResult> {
  // ── Build lookup maps ─────────────────────────────────────────────────────

  const fileGroupMap = new Map<string, FileGroup>()
  const nodeToFile = new Map<string, string>() // nodeId → fileGroupId

  for (const fg of fileGroups) {
    fileGroupMap.set(fg.id, fg)
    for (const cid of fg.childIds) {
      if (nodeIds.has(cid)) nodeToFile.set(cid, fg.id)
    }
  }

  // ── Group files by parent directory ──────────────────────────────────────

  const dirPathToFiles = new Map<string, FileGroup[]>()
  for (const fg of fileGroups) {
    const dir = fg.filePath ? parentDir(fg.filePath) : '.'
    if (!dirPathToFiles.has(dir)) dirPathToFiles.set(dir, [])
    dirPathToFiles.get(dir)!.push(fg)
  }

  // ── Shared setup ──────────────────────────────────────────────────────────

  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  // Pre-fill kind map — shared by both layout paths
  const edgeKindMap = new Map<string, string>()
  validEdges.forEach((e, i) => edgeKindMap.set(`e${i}`, e.kind))

  // Alternate layout directions between levels for 2D space coverage:
  //   root (between top-level compounds) → primary direction (view-mode driven)
  //   dir  (between file compounds)      → perpendicular
  //   file (between leaf nodes)          → primary direction again
  const rootDir = LAYOUT_OPTIONS[viewMode]['elk.direction'] ?? 'RIGHT'
  const perpDir = rootDir === 'RIGHT' || rootDir === 'LEFT' ? 'DOWN' : 'RIGHT'

  // Ungrouped nodes live at root level in both layouts
  const ungroupedNodes = nodes.filter((n) => !nodeToFile.has(n.id))
  const flatNodes: ElkNode[] = ungroupedNodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT }))

  // ── Determine layout tier ─────────────────────────────────────────────────
  //
  // Use 3-tier nesting (root → dir → file → node) only when there are 2 or more
  // meaningful directory paths. When all groups fall into the synthetic '.'
  // directory (e.g. contract grouping, or all files in one folder), skip the
  // dir tier and use a flat 2-tier layout (root → group → node) — a dir tier
  // that wraps everything adds visual noise without spatial information.

  const meaningfulDirCount = [...dirPathToFiles.keys()].filter((dp) => dp !== '.').length

  if (meaningfulDirCount < 2) {
    // ── Flat 2-tier layout (root → group compound → node) ────────────────────
    //
    // Used for contract grouping (no filePaths) and single-directory projects.
    // elk.hierarchyHandling: INCLUDE_CHILDREN on root ensures cross-compound
    // edges are routed correctly even though endpoints live inside compounds.

    const groupFileEdgeMap = new Map<string, ElkExtendedEdge[]>()
    const groupRootEdges: ElkExtendedEdge[] = []

    validEdges.forEach((e, i) => {
      const id = `e${i}`
      const elk_edge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }
      const srcGroup = nodeToFile.get(e.source)
      const tgtGroup = nodeToFile.get(e.target)
      if (srcGroup !== undefined && srcGroup === tgtGroup) {
        if (!groupFileEdgeMap.has(srcGroup)) groupFileEdgeMap.set(srcGroup, [])
        groupFileEdgeMap.get(srcGroup)!.push(elk_edge)
      } else {
        groupRootEdges.push(elk_edge)
      }
    })

    const groupElkNodes: ElkNode[] = []
    for (const fg of fileGroups) {
      const childElkNodes = fg.childIds
        .filter((id) => nodeIds.has(id))
        .map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT }))
      if (childElkNodes.length === 0) continue
      const n: ElkNode = {
        id: fg.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': rootDir,
          'elk.padding': '[top=36,left=10,bottom=10,right=10]',
          'elk.spacing.nodeNode': '20',
          'elk.layered.spacing.nodeNodeBetweenLayers': '30'
        },
        children: childElkNodes
      }
      const fe = groupFileEdgeMap.get(fg.id)
      if (fe?.length) n.edges = fe
      groupElkNodes.push(n)
    }

    const flatGraph: ElkNode = {
      id: 'root',
      layoutOptions: {
        ...LAYOUT_OPTIONS[viewMode],
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80'
      },
      children: [...groupElkNodes, ...flatNodes],
      edges: groupRootEdges
    }

    const flatLayouted = await elk.layout(flatGraph)

    const flatResultNodes = new Map<string, LayoutNode>()
    const flatContainers: FileContainer[] = []
    let flatMaxX = 0,
      flatMaxY = 0

    for (const child of flatLayouted.children ?? []) {
      const cx = child.x ?? 0
      const cy = child.y ?? 0
      const cw = child.width ?? NODE_WIDTH
      const ch = child.height ?? NODE_HEIGHT

      if (fileGroupMap.has(child.id)) {
        const fg = fileGroupMap.get(child.id)!
        // Pass fg.color through to the container so the canvas can render
        // a coloured border for contract groups
        flatContainers.push({ id: child.id, label: fg.label, color: fg.color, x: cx, y: cy, width: cw, height: ch })
        for (const gc of child.children ?? []) {
          flatResultNodes.set(gc.id, {
            id: gc.id,
            x: cx + (gc.x ?? 0),
            y: cy + (gc.y ?? 0),
            width: gc.width ?? NODE_WIDTH,
            height: gc.height ?? NODE_HEIGHT
          })
        }
      } else {
        flatResultNodes.set(child.id, { id: child.id, x: cx, y: cy, width: cw, height: ch })
      }
      if (cx + cw > flatMaxX) flatMaxX = cx + cw
      if (cy + ch > flatMaxY) flatMaxY = cy + ch
    }

    const flatResultEdges: LayoutEdge[] = []
    extractEdgeSections(flatLayouted, edgeKindMap, flatResultEdges)
    for (const child of flatLayouted.children ?? []) {
      if (fileGroupMap.has(child.id) && child.edges?.length) {
        extractEdgeSections(child, edgeKindMap, flatResultEdges, child.x ?? 0, child.y ?? 0)
      }
    }

    return {
      nodes: flatResultNodes,
      edges: flatResultEdges,
      containers: flatContainers,
      dirContainers: [],
      width: flatMaxX,
      height: flatMaxY
    }
  }

  // ── 3-tier nested layout (root → dir → file → node) ──────────────────────
  //
  // Edges placed at their Lowest Common Ancestor (LCA) container so ELK
  // routes them correctly at each level:
  //   same file           → file compound's .edges
  //   same dir, diff file → dir compound's .edges
  //   diff dir (or ungrouped) → root's .edges
  //
  // elk.hierarchyHandling: INCLUDE_CHILDREN on root and dir compounds lets ELK
  // route edges whose endpoints live inside nested children.

  // Assign stable ELK-safe ids for directory nodes (paths contain slashes)
  let dirIdx = 0
  const dirPathToId = new Map<string, string>()
  const dirIdToPath = new Map<string, string>()
  for (const dp of dirPathToFiles.keys()) {
    const id = `__dir${dirIdx++}`
    dirPathToId.set(dp, id)
    dirIdToPath.set(id, dp)
  }

  const dirIdSet = new Set(dirIdToPath.keys())

  const fileIdToDirId = new Map<string, string>() // fileGroupId → dirElkId
  for (const [dp, fgs] of dirPathToFiles) {
    const dirId = dirPathToId.get(dp)!
    for (const fg of fgs) fileIdToDirId.set(fg.id, dirId)
  }

  // ── Classify edges by LCA level ───────────────────────────────────────────

  const rootEdges: ElkExtendedEdge[] = []
  const dirEdgeMap = new Map<string, ElkExtendedEdge[]>() // dirElkId → edges
  const fileEdgeMap = new Map<string, ElkExtendedEdge[]>() // fileGroupId → edges

  validEdges.forEach((e, i) => {
    const id = `e${i}`
    const elk_edge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }

    const srcFile = nodeToFile.get(e.source)
    const tgtFile = nodeToFile.get(e.target)

    if (srcFile !== undefined && srcFile === tgtFile) {
      // Same file — within-file compound
      if (!fileEdgeMap.has(srcFile)) fileEdgeMap.set(srcFile, [])
      fileEdgeMap.get(srcFile)!.push(elk_edge)
    } else if (srcFile !== undefined && tgtFile !== undefined) {
      const srcDir = fileIdToDirId.get(srcFile)
      const tgtDir = fileIdToDirId.get(tgtFile)
      if (srcDir !== undefined && srcDir === tgtDir) {
        // Same dir, different files — within-dir compound
        if (!dirEdgeMap.has(srcDir)) dirEdgeMap.set(srcDir, [])
        dirEdgeMap.get(srcDir)!.push(elk_edge)
      } else {
        // Cross-dir — root
        rootEdges.push(elk_edge)
      }
    } else {
      // One or both endpoints ungrouped — root
      rootEdges.push(elk_edge)
    }
  })

  // ── Build ELK nested tree ─────────────────────────────────────────────────

  // File compound ElkNodes
  const fileElkNodes = new Map<string, ElkNode>()
  for (const fg of fileGroups) {
    const childElkNodes = fg.childIds
      .filter((id) => nodeIds.has(id))
      .map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT }))
    if (childElkNodes.length === 0) continue

    const n: ElkNode = {
      id: fg.id,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': rootDir,
        'elk.padding': '[top=36,left=10,bottom=10,right=10]',
        'elk.spacing.nodeNode': '20',
        'elk.layered.spacing.nodeNodeBetweenLayers': '30'
      },
      children: childElkNodes
    }
    const fe = fileEdgeMap.get(fg.id)
    if (fe?.length) n.edges = fe
    fileElkNodes.set(fg.id, n)
  }

  // Dir compound ElkNodes — each contains its file ElkNodes
  const dirElkNodes: ElkNode[] = []
  for (const [dp, fgs] of dirPathToFiles) {
    const dirId = dirPathToId.get(dp)!
    const children = fgs.map((fg) => fileElkNodes.get(fg.id)).filter((n): n is ElkNode => n !== undefined)
    if (children.length === 0) continue

    const dn: ElkNode = {
      id: dirId,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': perpDir,
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

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...LAYOUT_OPTIONS[viewMode],
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100'
    },
    children: [...dirElkNodes, ...flatNodes],
    edges: rootEdges
  }

  const layouted = await elk.layout(graph)

  // ── Extract positions ─────────────────────────────────────────────────────

  const resultNodes = new Map<string, LayoutNode>()
  const containers: FileContainer[] = []
  const dirContainers: FileContainer[] = []
  let maxX = 0,
    maxY = 0

  for (const dirChild of layouted.children ?? []) {
    const dx = dirChild.x ?? 0
    const dy = dirChild.y ?? 0
    const dw = dirChild.width ?? NODE_WIDTH
    const dh = dirChild.height ?? NODE_HEIGHT

    if (dirIdSet.has(dirChild.id)) {
      // Directory compound → visual dir container
      const dp = dirIdToPath.get(dirChild.id)!
      dirContainers.push({ id: dirChild.id, label: dirLabel(dp), x: dx, y: dy, width: dw, height: dh })

      // File compounds are grandchildren of root (direct children of dir)
      for (const fileChild of dirChild.children ?? []) {
        const fx = dx + (fileChild.x ?? 0)
        const fy = dy + (fileChild.y ?? 0)
        const fw = fileChild.width ?? NODE_WIDTH
        const fh = fileChild.height ?? NODE_HEIGHT

        if (fileGroupMap.has(fileChild.id)) {
          const fg = fileGroupMap.get(fileChild.id)!
          containers.push({ id: fileChild.id, label: fg.label, x: fx, y: fy, width: fw, height: fh })

          // Leaf nodes are great-grandchildren of root
          for (const gc of fileChild.children ?? []) {
            const x = fx + (gc.x ?? 0)
            const y = fy + (gc.y ?? 0)
            resultNodes.set(gc.id, {
              id: gc.id,
              x,
              y,
              width: gc.width ?? NODE_WIDTH,
              height: gc.height ?? NODE_HEIGHT
            })
          }
        } else {
          // Unknown child — treat as flat
          resultNodes.set(fileChild.id, { id: fileChild.id, x: fx, y: fy, width: fw, height: fh })
        }
      }
    } else {
      // Ungrouped flat node at root level
      resultNodes.set(dirChild.id, { id: dirChild.id, x: dx, y: dy, width: dw, height: dh })
    }

    if (dx + dw > maxX) maxX = dx + dw
    if (dy + dh > maxY) maxY = dy + dh
  }

  // ── Extract edge routes ───────────────────────────────────────────────────
  //
  // Edge sections are in the local coordinate system of the compound node that
  // holds the edge. Accumulate the absolute offset at each nesting level.

  const resultEdges: LayoutEdge[] = []

  // Root-level cross-dir edges — already in global coords (offset 0,0)
  extractEdgeSections(layouted, edgeKindMap, resultEdges)

  for (const dirChild of layouted.children ?? []) {
    if (!dirIdSet.has(dirChild.id)) continue
    const dx = dirChild.x ?? 0
    const dy = dirChild.y ?? 0

    // Dir-level same-dir/cross-file edges — offset by dir position
    if (dirChild.edges?.length) {
      extractEdgeSections(dirChild, edgeKindMap, resultEdges, dx, dy)
    }

    // File-level same-file edges — offset by dir + file position
    for (const fileChild of dirChild.children ?? []) {
      if (fileChild.edges?.length) {
        const fx = dx + (fileChild.x ?? 0)
        const fy = dy + (fileChild.y ?? 0)
        extractEdgeSections(fileChild, edgeKindMap, resultEdges, fx, fy)
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges, containers, dirContainers, width: maxX, height: maxY }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run ELK layout on the given nodes and edges.
 *
 * When fileGroups is provided (and non-empty), the layout uses ELK compound
 * nodes so each file's children are spatially grouped together. The result
 * includes a `containers` array of bounding boxes for the file groups.
 *
 * mrtree (impact-radius) does not support compound nodes — fileGroups is
 * ignored for that view mode and a flat layout runs instead.
 */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  viewMode: ViewMode,
  fileGroups?: FileGroup[]
): Promise<LayoutResult> {
  const nodeIds = new Set(nodes.map((n) => n.id))

  if (fileGroups && fileGroups.length > 0 && viewMode !== 'impact-radius') {
    return layoutGrouped(nodes, edges, viewMode, fileGroups, nodeIds)
  }

  return layoutFlat(nodes, edges, viewMode, nodeIds)
}
