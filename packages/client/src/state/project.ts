import type { FileGroup, GraphEdge, GraphNode, ProjectStats, ViewParams } from '@graphcoder/core'
import { batch } from 'solid-js'
import * as api from '../api/graph.js'
import { state, setState } from './core.js'
import { loadAnnotations } from './annotations.js'
import { recomputeDiff } from './diff.js'
import { loadFilters, loadHierarchy } from './storage.js'
import { syncUrlParams } from './url.js'

// ── Project ───────────────────────────────────────────────────────────────────

export interface ProjectState {
  projectRoot: string | null
  projectStats: ProjectStats | null
  isLoading: boolean
  error: string | null
}

/**
 * Reload persisted filter and hierarchy state for the current project.
 *
 * Called after setting `projectRoot` so localStorage reads use the
 * project-scoped key. The reactive effect in App.tsx picks up the
 * state changes and sends an updated view_request to the server.
 */
function reloadPersistedState(): void {
  const path = state.projectRoot
  const filters = loadFilters(path)
  const hierarchy = loadHierarchy(path)
  batch(() => {
    if (filters.hiddenNodeKinds !== undefined) setState('hiddenNodeKinds', filters.hiddenNodeKinds)
    if (filters.hiddenEdgeKinds !== undefined) setState('hiddenEdgeKinds', filters.hiddenEdgeKinds)
    if (filters.excludePatterns !== undefined) setState('excludePatterns', filters.excludePatterns)
    if (filters.groupByFile !== undefined) setState('groupByFile', filters.groupByFile)
    if (filters.groupByContract !== undefined) setState('groupByContract', filters.groupByContract)
    if (filters.groupByClass !== undefined) setState('groupByClass', filters.groupByClass)
    if (filters.groupByPackage !== undefined) setState('groupByPackage', filters.groupByPackage)
    if (filters.graphDirection !== undefined) setState('graphDirection', filters.graphDirection)
    if (hierarchy.hiddenPaths !== undefined) setState('hiddenPaths', hierarchy.hiddenPaths)
    if (hierarchy.expandedGroups !== undefined) setState('expandedGroups', hierarchy.expandedGroups)
  })
}

/**
 * Open a project by root path. Clears any stale view data before calling the
 * server, so the canvas never shows a previous project's layout while loading.
 * The actual graph data arrives via the WebSocket view_snapshot after the server
 * opens the project and broadcasts.
 */
export async function openProject(projectRoot: string): Promise<void> {
  setState('viewNodes', [])
  setState('viewEdges', [])
  setState('viewGroups', [])
  setState('fileNodes', [])
  setState('isLoading', true)
  setState('error', null)
  try {
    const result = await api.openProject(projectRoot)
    setState('projectRoot', result.projectRoot)
    setState('projectStats', result.stats)
    reloadPersistedState()
    syncUrlParams()
    // The server broadcasts view_snapshot + hierarchy_snapshot to all connected
    // clients after opening the project, so no explicit fetch is needed here.
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to open project')
  } finally {
    setState('isLoading', false)
  }
}

/**
 * Restore state from URL params on startup, then fall back to the server's
 * current project if no URL param specifies one.
 *
 * Recognised params:
 *   - `project` — absolute path of the project to open
 *   - `base`    — base commit hash for a temporal diff
 *   - `target`  — target commit hash for a temporal diff
 *
 * When both `base` and `target` appear in the URL, the git graph panel
 * opens automatically and a temporal diff starts after the project loads.
 */
export async function initFromUrl(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const projectParam = params.get('project')
  const baseParam = params.get('base')
  const targetParam = params.get('target')

  if (projectParam) {
    await openProject(projectParam)
  } else {
    // No URL param — check whether the server already has a project open.
    // If so, request its current view; the WS view_snapshot will deliver the data.
    try {
      const result = await api.fetchCurrentProject()
      if (result.open && result.projectRoot) {
        setState('projectRoot', result.projectRoot)
        if (result.stats) setState('projectStats', result.stats)
        reloadPersistedState()
        syncUrlParams()
        // sendViewRequest() is called by the view-params effect in App.tsx as
        // soon as the WebSocket is open, so no explicit call is needed here.
      }
    } catch {
      // Server has no project open yet — not an error.
    }
  }

  // Restore diff range from URL. Set refs first, then trigger the diff.
  if (baseParam) setState('baseRef', baseParam)
  if (targetParam) setState('targetRef', targetParam)
  if (baseParam || targetParam) syncUrlParams()

  if (baseParam && targetParam && state.projectRoot) {
    // Open the git graph panel so the user sees the selected commits,
    // then load the graph data and run the diff.
    setState('gitBarOpen', true)
    const { loadGitGraph, runTemporalDiff } = await import('./temporal.js')
    await loadGitGraph()
    await runTemporalDiff()
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

// Module-level WS reference — sendViewRequest() uses this to push new params.
let activeWs: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Send the current view params to the server.
 * The server recomputes the view and sends back a view_snapshot.
 * No-ops if the WebSocket is not yet open.
 *
 * Debounced by 50 ms so rapid filter toggles (e.g. clicking several
 * checkboxes) collapse into a single server computation.
 */
let viewRequestTimer: ReturnType<typeof setTimeout> | undefined

export function sendViewRequest(params: ViewParams): void {
  clearTimeout(viewRequestTimer)
  viewRequestTimer = setTimeout(() => {
    if (activeWs?.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: 'view_request', params }))
    }
  }, 50)
}

/**
 * Open a WebSocket connection to the server and keep it alive with exponential
 * reconnect. Handles:
 *   - view_snapshot → updates viewNodes / viewEdges / viewGroups
 *   - hierarchy_snapshot → updates fileNodes
 */
export function connectWebSocket(): void {
  const wsUrl = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:3001/ws`

  const connect = () => {
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }

    const ws = new WebSocket(wsUrl)
    activeWs = ws

    ws.addEventListener('open', () => {
      // The createEffect in App.tsx fires on mount BEFORE the WS is open, so
      // that initial sendViewRequest is a no-op.  Send the client's persisted
      // params now so the server uses the correct config on the very first
      // layout — no wasted DEFAULT_VIEW_PARAMS computation.
      ws.send(
        JSON.stringify({
          type: 'view_request',
          params: {
            hiddenNodeKinds: state.hiddenNodeKinds,
            hiddenEdgeKinds: state.hiddenEdgeKinds,
            hiddenPaths: state.hiddenPaths,
            excludePatterns: state.excludePatterns,
            groupByFile: state.groupByFile,
            groupByClass: state.groupByClass,
            groupByContract: state.groupByContract,
            groupByPackage: state.groupByPackage,
            expandedGroups: state.expandedGroups,
            focusedNodeId: state.focusedNodeId
          } satisfies ViewParams
        })
      )
    })

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string
          nodes?: GraphNode[]
          edges?: GraphEdge[]
          groups?: FileGroup[]
          fileNodes?: GraphNode[]
          id?: string
          label?: string
        }

        if (data.type === 'view_snapshot') {
          if (state.savedView) {
            // A temporal diff occupies the display. Route the live view data
            // into savedView so it restores correctly when the diff clears.
            // Do NOT overwrite the diff view on screen.
            batch(() => {
              setState('savedView', {
                nodes: data.nodes ?? state.savedView!.nodes,
                edges: data.edges ?? state.savedView!.edges,
                groups: data.groups ?? state.savedView!.groups,
                fileNodes: data.fileNodes ?? state.savedView!.fileNodes
              })
            })
          } else {
            // No diff active — update the live display directly.
            batch(() => {
              if (data.nodes !== undefined) setState('viewNodes', data.nodes)
              if (data.edges !== undefined) setState('viewEdges', data.edges)
              if (data.groups !== undefined) setState('viewGroups', data.groups)
              if (data.fileNodes !== undefined) setState('fileNodes', data.fileNodes)
            })
            recomputeDiff(data.nodes ?? state.viewNodes, data.edges ?? state.viewEdges)
          }
        }

        if (data.type === 'annotations_changed') {
          void loadAnnotations()
        }

        if (data.type === 'annotation_proposed') {
          // A new AI proposal arrived — reload annotations
          void loadAnnotations()
        }

        if (data.type === 'annotation_refined') {
          // A proposal was refined — reload annotations
          void loadAnnotations()
        }

        if (data.type === 'hierarchy_snapshot') {
          if (state.savedView) {
            // Temporal diff active — stash the live file nodes for restore.
            if (data.fileNodes !== undefined) {
              setState('savedView', { ...state.savedView, fileNodes: data.fileNodes })
            }
          } else {
            if (data.fileNodes !== undefined) setState('fileNodes', data.fileNodes)
          }
        }
      } catch {
        // Ignore malformed messages.
      }
    })

    ws.addEventListener('close', () => {
      activeWs = null
      wsReconnectTimer = setTimeout(connect, 2000)
    })

    ws.addEventListener('error', () => {
      ws.close()
    })
  }

  connect()
}
