import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { graphService } from './codegraph/service.js'
import type { Node, Edge } from '@colbymchenry/codegraph'

interface SerializedNode {
  id: string
  kind: Node['kind']
  name: string
  qualifiedName: string
  filePath: string
  language: Node['language']
  startLine: number
  endLine: number
  signature?: string
  docstring?: string
  isExported?: boolean
}

interface SerializedEdge {
  source: string
  target: string
  kind: Edge['kind']
}

function serializeNode(node: Node): SerializedNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    isExported: node.isExported
  }
}

function serializeEdge(edge: Edge): SerializedEdge {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind
  }
}

function getSerializedGraphData(): { nodes: SerializedNode[]; edges: SerializedEdge[] } {
  if (!graphService.isOpen()) {
    return { nodes: [], edges: [] }
  }
  const { nodes, edges } = graphService.getAllNodesAndEdges()
  return {
    nodes: nodes.map(serializeNode),
    edges: edges.map(serializeEdge)
  }
}

let wss: WebSocketServer | null = null

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    const { nodes, edges } = getSerializedGraphData()
    ws.send(JSON.stringify({ type: 'graph_snapshot', nodes, edges }))
  })
}

export function broadcastGraphUpdate(): void {
  if (!wss || !graphService.isOpen()) return

  const { nodes, edges } = getSerializedGraphData()
  const message = JSON.stringify({ type: 'graph_update', nodes, edges })

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}
