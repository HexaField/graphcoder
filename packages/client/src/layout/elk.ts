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
}

/** A rendered file container box returned from a grouped layout. */
export interface FileContainer {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  /** Non-empty only when layoutGraph was called with fileGroups. */
  containers: FileContainer[]
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

  return { nodes: resultNodes, edges: resultEdges, containers: [], width: maxX, height: maxY }
}

// ── Grouped layout (compound nodes per file) ──────────────────────────────────

async function layoutGrouped(
  nodes: GraphNode[],
  edges: GraphEdge[],
  viewMode: ViewMode,
  fileGroups: FileGroup[],
  nodeIds: Set<string>
): Promise<LayoutResult> {
  // Build fast lookups
  const nodeToGroup = new Map<string, string>()
  const groupIdSet = new Set<string>()
  const groupMap = new Map<string, FileGroup>()

  for (const fg of fileGroups) {
    groupIdSet.add(fg.id)
    groupMap.set(fg.id, fg)
    for (const childId of fg.childIds) {
      if (!nodeToGroup.has(childId)) nodeToGroup.set(childId, fg.id)
    }
  }

  // Nodes not inside any group → lay out at root level
  const ungroupedNodes = nodes.filter((n) => !nodeToGroup.has(n.id))

  // Classify edges by whether both endpoints sit in the same group
  const withinEdges = new Map<string, ElkExtendedEdge[]>()
  const rootEdges: ElkExtendedEdge[] = []
  const edgeKindMap = new Map<string, string>()

  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  validEdges.forEach((e, i) => {
    const id = `e${i}`
    edgeKindMap.set(id, e.kind)
    const elkEdge: ElkExtendedEdge = { id, sources: [e.source], targets: [e.target] }
    const srcGroup = nodeToGroup.get(e.source)
    const tgtGroup = nodeToGroup.get(e.target)
    if (srcGroup !== undefined && srcGroup === tgtGroup) {
      if (!withinEdges.has(srcGroup)) withinEdges.set(srcGroup, [])
      withinEdges.get(srcGroup)!.push(elkEdge)
    } else {
      rootEdges.push(elkEdge)
    }
  })

  // Build ELK compound nodes for each file group
  const childDirection = LAYOUT_OPTIONS[viewMode]['elk.direction'] ?? 'DOWN'
  const compoundNodes: ElkNode[] = fileGroups.map((fg) => {
    const childElkNodes = fg.childIds
      .filter((id) => nodeIds.has(id))
      .map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT }))

    const node: ElkNode = {
      id: fg.id,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': childDirection,
        'elk.padding': '[top=36,left=10,bottom=10,right=10]',
        'elk.spacing.nodeNode': '20',
        'elk.layered.spacing.nodeNodeBetweenLayers': '30'
      },
      children: childElkNodes
    }
    const we = withinEdges.get(fg.id)
    if (we && we.length > 0) node.edges = we
    return node
  })

  // Ungrouped flat nodes alongside the compound nodes
  const flatNodes: ElkNode[] = ungroupedNodes.map((n) => ({
    id: n.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT
  }))

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...LAYOUT_OPTIONS[viewMode],
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80'
    },
    children: [...compoundNodes, ...flatNodes],
    edges: rootEdges
  }

  const layouted = await elk.layout(graph)

  const resultNodes = new Map<string, LayoutNode>()
  const containers: FileContainer[] = []
  let maxX = 0,
    maxY = 0

  for (const child of layouted.children ?? []) {
    const cx = child.x ?? 0
    const cy = child.y ?? 0
    const cw = child.width ?? NODE_WIDTH
    const ch = child.height ?? NODE_HEIGHT

    if (groupIdSet.has(child.id)) {
      // Compound node → becomes a visual container
      const fg = groupMap.get(child.id)!
      containers.push({ id: child.id, label: fg.label, x: cx, y: cy, width: cw, height: ch })

      // Children have positions relative to compound node's top-left
      for (const grandchild of child.children ?? []) {
        const x = cx + (grandchild.x ?? 0)
        const y = cy + (grandchild.y ?? 0)
        const w = grandchild.width ?? NODE_WIDTH
        const h = grandchild.height ?? NODE_HEIGHT
        resultNodes.set(grandchild.id, { id: grandchild.id, x, y, width: w, height: h })
      }
    } else {
      // Ungrouped flat node
      resultNodes.set(child.id, { id: child.id, x: cx, y: cy, width: cw, height: ch })
    }

    if (cx + cw > maxX) maxX = cx + cw
    if (cy + ch > maxY) maxY = cy + ch
  }

  // Root-level edges (absolute coordinates)
  const resultEdges: LayoutEdge[] = []
  extractEdgeSections(layouted, edgeKindMap, resultEdges)

  // Within-compound edges (relative coords → add compound node offset)
  for (const child of layouted.children ?? []) {
    if (groupIdSet.has(child.id) && child.edges && child.edges.length > 0) {
      extractEdgeSections(child, edgeKindMap, resultEdges, child.x ?? 0, child.y ?? 0)
    }
  }

  return { nodes: resultNodes, edges: resultEdges, containers, width: maxX, height: maxY }
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
