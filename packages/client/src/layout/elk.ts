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

export interface LayoutResult {
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  width: number
  height: number
}

export async function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], viewMode: ViewMode): Promise<LayoutResult> {
  const nodeIds = new Set(nodes.map((n) => n.id))

  // Only include edges where both endpoints exist in the node set
  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))

  const elkNodes: ElkNode[] = nodes.map((n) => ({
    id: n.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT
  }))

  // Use index-based IDs to avoid duplicates when multiple edges connect the same pair
  const elkEdges: ElkExtendedEdge[] = validEdges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.source],
    targets: [e.target]
  }))

  // Map edge index → kind for post-layout lookup
  const edgeKindMap = new Map<string, string>()
  validEdges.forEach((e, i) => {
    edgeKindMap.set(`e${i}`, e.kind)
  })

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS[viewMode],
    children: elkNodes,
    edges: elkEdges
  }

  const layouted = await elk.layout(graph)

  const resultNodes = new Map<string, LayoutNode>()
  let maxX = 0
  let maxY = 0

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

  for (const edge of layouted.edges ?? []) {
    const extEdge = edge as ElkExtendedEdge
    const source = extEdge.sources[0] ?? ''
    const target = extEdge.targets[0] ?? ''
    const edgeId = extEdge.id ?? ''

    const sections = (extEdge.sections ?? []).map((s) => ({
      startPoint: { x: s.startPoint.x, y: s.startPoint.y },
      endPoint: { x: s.endPoint.x, y: s.endPoint.y },
      bendPoints: s.bendPoints?.map((p) => ({ x: p.x, y: p.y }))
    }))

    resultEdges.push({
      id: edgeId,
      source,
      target,
      kind: edgeKindMap.get(edgeId),
      sections
    })
  }

  return {
    nodes: resultNodes,
    edges: resultEdges,
    width: maxX,
    height: maxY
  }
}
