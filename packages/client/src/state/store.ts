import { createStore } from 'solid-js/store'
import type { EdgeKind, GraphEdge, GraphNode, NodeDetail, NodeKind, ProjectStats, ViewMode } from '@graphcoder/core'
import * as api from '../api/graph.js'

const VIEW_MODES: ViewMode[] = ['module-dependency', 'call-graph', 'impact-radius']

// ── URL persistence ───────────────────────────────────────────────────────────

function syncUrlParams(): void {
  const params = new URLSearchParams()
  if (state.projectRoot) params.set('project', state.projectRoot)
  params.set('view', state.viewMode)
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}

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

  // Filters & focus
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  focusedNodeId: string | null

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
  hiddenNodeKinds: [],
  hiddenEdgeKinds: [],
  focusedNodeId: null,
  searchQuery: '',
  searchResults: [],
  isSearching: false
})

// ── Filters & focus ───────────────────────────────────────────────────────────

export function toggleNodeKind(kind: NodeKind): void {
  setState('hiddenNodeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
}

export function toggleEdgeKind(kind: EdgeKind): void {
  setState('hiddenEdgeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
}

export function setFocus(nodeId: string): void {
  setState('focusedNodeId', nodeId)
}

export function clearFocus(): void {
  setState('focusedNodeId', null)
}

export function clearFilters(): void {
  setState('hiddenNodeKinds', [])
  setState('hiddenEdgeKinds', [])
}

/**
 * Derive the currently visible nodes and edges by applying:
 *   1. Node kind filter  (hiddenNodeKinds)
 *   2. Individual node focus  (focusedNodeId → neighbourhood)
 *   3. Edge kind filter  (hiddenEdgeKinds) + endpoints must be in visible set
 *
 * Call this inside a reactive context (createMemo / createEffect) so that
 * SolidJS tracks every state path it reads.
 */
export function visibleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hiddenKindSet = new Set(state.hiddenNodeKinds)
  const hiddenEdgeSet = new Set(state.hiddenEdgeKinds)

  // 1. Apply node kind filter
  let nodes = state.nodes.filter((n) => !hiddenKindSet.has(n.kind))
  let nodeIds = new Set(nodes.map((n) => n.id))

  // 2. Apply focus: narrow to focused node + its direct neighbours
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

  // 3. Filter edges: kind not hidden + both endpoints visible
  const edges = state.edges.filter((e) => !hiddenEdgeSet.has(e.kind) && nodeIds.has(e.source) && nodeIds.has(e.target))

  return { nodes, edges }
}

// ── Project ───────────────────────────────────────────────────────────────────

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
    syncUrlParams()
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
  syncUrlParams()
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

/** Restore state from URL params on startup, then fall back to the server's current project. */
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
        syncUrlParams()
      }
    } catch {
      // Server has no project open yet — not an error
    }
  }
}

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

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
