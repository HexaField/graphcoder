import type { GraphEdge, GraphNode, ViewMode } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { state, setState } from './core.js'
import { recomputeDiff } from './diff.js'
import { syncUrlParams, VIEW_MODES } from './url.js'

// ── Project ───────────────────────────────────────────────────────────────────

/**
 * Open a project by root path. Clears any stale graph data before fetching
 * so the canvas never shows a previous project's layout while loading.
 */
export async function openProject(projectRoot: string): Promise<void> {
  setState('nodes', [])
  setState('edges', [])
  setState('isLoading', true)
  setState('error', null)
  try {
    const result = await api.openProject(projectRoot)
    setState('projectRoot', result.projectRoot)
    setState('projectStats', result.stats)
    const graph = await api.fetchGraph()
    setState('nodes', graph.nodes)
    setState('edges', graph.edges)
    recomputeDiff(graph.nodes, graph.edges)
    syncUrlParams()
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to open project')
  } finally {
    setState('isLoading', false)
  }
}

/**
 * Restore state from URL params on startup, then fall back to the server's
 * current project if no URL param specifies one.
 */
export async function initFromUrl(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const projectParam = params.get('project')
  const viewParam = params.get('view') as ViewMode | null

  if (viewParam && VIEW_MODES.includes(viewParam)) {
    setState('viewMode', viewParam)
  }

  if (projectParam) {
    await openProject(projectParam)
  } else {
    // No URL param — check whether the server already has a project open
    try {
      const result = await api.fetchCurrentProject()
      if (result.open && result.projectRoot) {
        setState('projectRoot', result.projectRoot)
        if (result.stats) setState('projectStats', result.stats)
        const graph = await api.fetchGraph()
        setState('nodes', graph.nodes)
        setState('edges', graph.edges)
        recomputeDiff(graph.nodes, graph.edges)
        syncUrlParams()
      }
    } catch {
      // Server has no project open yet — not an error
    }
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Open a WebSocket connection to the server and keep it alive with exponential
 * reconnect. Updates the graph store on every `graph_snapshot` / `graph_update`
 * message.
 */
export function connectWebSocket(): void {
  const wsUrl = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:3001/ws`

  const connect = () => {
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }

    const ws = new WebSocket(wsUrl)

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string
          nodes?: GraphNode[]
          edges?: GraphEdge[]
        }
        if (data.type === 'graph_snapshot' || data.type === 'graph_update') {
          if (data.nodes) setState('nodes', data.nodes)
          if (data.edges) setState('edges', data.edges)
          if (data.nodes || data.edges) {
            recomputeDiff(data.nodes ?? state.nodes, data.edges ?? state.edges)
          }
        }
      } catch {
        // ignore malformed messages
      }
    })

    ws.addEventListener('close', () => {
      wsReconnectTimer = setTimeout(connect, 2000)
    })

    ws.addEventListener('error', () => {
      ws.close()
    })
  }

  connect()
}
