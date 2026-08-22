import { createStore } from 'solid-js/store'
import type { GraphEdge, GraphNode, NodeDetail, ProjectStats, ViewMode } from '@graphcoder/core'
import * as api from '../api/graph.js'

interface AppState {
  // Project
  projectRoot: string | null
  projectStats: ProjectStats | null
  isLoading: boolean
  error: string | null

  // Graph
  nodes: GraphNode[]
  edges: GraphEdge[]

  // Selection
  selectedNodeId: string | null
  selectedNodeDetail: NodeDetail | null
  isLoadingDetail: boolean

  // View
  viewMode: ViewMode

  // Search
  searchQuery: string
  searchResults: { node: GraphNode; score: number }[]
  isSearching: boolean
}

export const [state, setState] = createStore<AppState>({
  projectRoot: null,
  projectStats: null,
  isLoading: false,
  error: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedNodeDetail: null,
  isLoadingDetail: false,
  viewMode: 'module-dependency',
  searchQuery: '',
  searchResults: [],
  isSearching: false
})

export async function openProject(projectRoot: string): Promise<void> {
  setState('isLoading', true)
  setState('error', null)
  try {
    const result = await api.openProject(projectRoot)
    setState('projectRoot', result.projectRoot)
    setState('projectStats', result.stats)
    const graph = await api.fetchGraph()
    setState('nodes', graph.nodes)
    setState('edges', graph.edges)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to open project')
  } finally {
    setState('isLoading', false)
  }
}

export async function selectNode(nodeId: string): Promise<void> {
  setState('selectedNodeId', nodeId)
  setState('selectedNodeDetail', null)
  setState('isLoadingDetail', true)
  try {
    const detail = await api.fetchNodeDetail(nodeId)
    setState('selectedNodeDetail', detail)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to load node detail')
  } finally {
    setState('isLoadingDetail', false)
  }
}

export function clearSelection(): void {
  setState('selectedNodeId', null)
  setState('selectedNodeDetail', null)
}

export async function setViewMode(mode: ViewMode): Promise<void> {
  setState('viewMode', mode)
  try {
    if (mode === 'call-graph' && state.selectedNodeId) {
      const subgraph = await api.fetchCallGraph(state.selectedNodeId)
      setState('nodes', subgraph.nodes)
      setState('edges', subgraph.edges)
    } else if (mode === 'impact-radius' && state.selectedNodeId) {
      const subgraph = await api.fetchImpactRadius(state.selectedNodeId)
      setState('nodes', subgraph.nodes)
      setState('edges', subgraph.edges)
    } else {
      const graph = await api.fetchGraph()
      setState('nodes', graph.nodes)
      setState('edges', graph.edges)
    }
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to load graph')
  }
}

export async function search(query: string): Promise<void> {
  setState('searchQuery', query)
  if (!query.trim()) {
    setState('searchResults', [])
    return
  }
  setState('isSearching', true)
  try {
    const result = await api.searchNodes(query)
    setState('searchResults', result.results)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Search failed')
  } finally {
    setState('isSearching', false)
  }
}

export async function fetchCurrentProject(): Promise<void> {
  try {
    const result = await api.fetchCurrentProject()
    if (result.open && result.projectRoot) {
      setState('projectRoot', result.projectRoot)
      if (result.stats) setState('projectStats', result.stats)
      const graph = await api.fetchGraph()
      setState('nodes', graph.nodes)
      setState('edges', graph.edges)
    }
  } catch {
    // Server may not have a project open yet — not an error
  }
}

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWebSocket(): void {
  const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws'

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
