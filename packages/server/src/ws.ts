import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ViewParams } from '@graphcoder/core'
import { computeView, DEFAULT_VIEW_PARAMS } from '@graphcoder/core'
import { graphService } from './codegraph/service.js'

// Per-connection view params — each client independently controls its own view.
const clientParams = new Map<WebSocket, ViewParams>()

let wss: WebSocketServer | null = null

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendViewSnapshot(ws: WebSocket, params: ViewParams): void {
  if (!graphService.isOpen()) {
    ws.send(JSON.stringify({ type: 'view_snapshot', nodes: [], edges: [], groups: [], fileNodes: [] }))
    return
  }
  const { nodes: allNodes, edges: allEdges } = graphService.getAllNodesAndEdges()
  const result = computeView(allNodes, allEdges, params)
  ws.send(JSON.stringify({ type: 'view_snapshot', ...result }))
}

function sendHierarchySnapshot(ws: WebSocket): void {
  // Hierarchy snapshot — sent once on connect so the sidebar can build its
  // file/directory tree without the client needing the full raw graph.
  // The same fileNodes field also arrives inside each view_snapshot; this
  // initial message lets the panel render before any view_request round-trip.
  if (!graphService.isOpen()) {
    ws.send(JSON.stringify({ type: 'hierarchy_snapshot', fileNodes: [] }))
    return
  }
  const { nodes } = graphService.getAllNodesAndEdges({ includeSynthetic: false })
  const fileNodes = nodes.filter((n) => n.kind === 'file' || n.kind === 'module')
  ws.send(JSON.stringify({ type: 'hierarchy_snapshot', fileNodes }))
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    const params = { ...DEFAULT_VIEW_PARAMS }
    clientParams.set(ws, params)

    // Send the initial data immediately on connect.
    sendHierarchySnapshot(ws)
    sendViewSnapshot(ws, params)

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; params?: ViewParams }

        if (msg.type === 'view_request' && msg.params) {
          const newParams = msg.params
          clientParams.set(ws, newParams)
          sendViewSnapshot(ws, newParams)
        }
      } catch {
        // Ignore malformed messages.
      }
    })

    ws.on('close', () => {
      clientParams.delete(ws)
    })
  })
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

/**
 * Re-send each connected client's current view snapshot after a graph change
 * (file save, manual sync, etc.). Each client gets the view filtered to its
 * own current params, so different clients see different scopes simultaneously.
 */
export function broadcastGraphUpdate(): void {
  if (!wss || !graphService.isOpen()) return

  for (const [client, params] of clientParams) {
    if (client.readyState === WebSocket.OPEN) {
      sendHierarchySnapshot(client)
      sendViewSnapshot(client, params)
    }
  }
}
