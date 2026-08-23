import { createStore } from 'solid-js/store'
import type {
  ArchDiff,
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  NodeDetail,
  NodeKind,
  ProjectStats,
  ViewMode
} from '@graphcoder/core'
import { computeArchDiff } from '@graphcoder/core'
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
  hideTestFiles: boolean
  hideDevFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  focusedNodeId: string | null

  // Diff
  baseSnapshot: GraphSnapshot | null
  currentDiff: ArchDiff | null

  // Search
  searchQuery: string
  searchResults: { node: GraphNode; score: number }[]
  isSearching: boolean
}

// ── Filter persistence ────────────────────────────────────────────────────────

const FILTER_KEY = 'graphcoder-filters'

interface PersistedFilters {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  hideTestFiles: boolean
  hideDevFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
}

function loadFilters(): Partial<PersistedFilters> {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return {}
    return {
      hiddenNodeKinds: Array.isArray(p.hiddenNodeKinds) ? (p.hiddenNodeKinds as NodeKind[]) : undefined,
      hiddenEdgeKinds: Array.isArray(p.hiddenEdgeKinds) ? (p.hiddenEdgeKinds as EdgeKind[]) : undefined,
      hideTestFiles: typeof p.hideTestFiles === 'boolean' ? p.hideTestFiles : undefined,
      hideDevFiles: typeof p.hideDevFiles === 'boolean' ? p.hideDevFiles : undefined,
      groupByFile: typeof p.groupByFile === 'boolean' ? p.groupByFile : undefined,
      groupByContract: typeof p.groupByContract === 'boolean' ? p.groupByContract : undefined,
      groupByClass: typeof p.groupByClass === 'boolean' ? p.groupByClass : undefined,
      groupByPackage: typeof p.groupByPackage === 'boolean' ? p.groupByPackage : undefined
    }
  } catch {
    return {}
  }
}

function persistFilters(): void {
  try {
    const f: PersistedFilters = {
      hiddenNodeKinds: state.hiddenNodeKinds,
      hiddenEdgeKinds: state.hiddenEdgeKinds,
      hideTestFiles: state.hideTestFiles,
      hideDevFiles: state.hideDevFiles,
      groupByFile: state.groupByFile,
      groupByContract: state.groupByContract,
      groupByClass: state.groupByClass,
      groupByPackage: state.groupByPackage
    }
    localStorage.setItem(FILTER_KEY, JSON.stringify(f))
  } catch {
    // localStorage unavailable (quota exceeded, private-browsing restriction, etc.)
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

const _saved = loadFilters()

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
  hiddenNodeKinds: _saved.hiddenNodeKinds ?? [],
  hiddenEdgeKinds: _saved.hiddenEdgeKinds ?? [],
  hideTestFiles: _saved.hideTestFiles ?? false,
  hideDevFiles: _saved.hideDevFiles ?? false,
  groupByFile: _saved.groupByFile ?? false,
  groupByContract: _saved.groupByContract ?? false,
  groupByClass: _saved.groupByClass ?? false,
  groupByPackage: _saved.groupByPackage ?? false,
  focusedNodeId: null,
  baseSnapshot: null,
  currentDiff: null,
  searchQuery: '',
  searchResults: [],
  isSearching: false
})

// ── Filters & focus ───────────────────────────────────────────────────────────

export function toggleNodeKind(kind: NodeKind): void {
  setState('hiddenNodeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persistFilters()
}

export function toggleEdgeKind(kind: EdgeKind): void {
  setState('hiddenEdgeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persistFilters()
}

export function setFocus(nodeId: string): void {
  setState('focusedNodeId', nodeId)
}

export function clearFocus(): void {
  setState('focusedNodeId', null)
}

export function toggleHideTestFiles(): void {
  setState('hideTestFiles', (v) => !v)
  persistFilters()
}

export function toggleHideDevFiles(): void {
  setState('hideDevFiles', (v) => !v)
  persistFilters()
}

export function toggleGroupByFile(): void {
  setState('groupByFile', (v) => !v)
  persistFilters()
}

export function toggleGroupByContract(): void {
  setState('groupByContract', (v) => !v)
  persistFilters()
}

export function toggleGroupByClass(): void {
  setState('groupByClass', (v) => !v)
  persistFilters()
}

export function toggleGroupByPackage(): void {
  setState('groupByPackage', (v) => !v)
  persistFilters()
}

export function clearFilters(): void {
  setState('hiddenNodeKinds', [])
  setState('hiddenEdgeKinds', [])
  setState('hideTestFiles', false)
  setState('hideDevFiles', false)
  setState('groupByFile', false)
  setState('groupByContract', false)
  setState('groupByClass', false)
  setState('groupByPackage', false)
  persistFilters()
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/** Capture the current graph as the diff baseline. */
export function captureSnapshot(): void {
  setState('baseSnapshot', { nodes: [...state.nodes], edges: [...state.edges] })
  setState('currentDiff', null)
}

/** Discard the baseline and clear any computed diff. */
export function clearDiff(): void {
  setState('baseSnapshot', null)
  setState('currentDiff', null)
}

/** Recompute the diff against the current snapshot. Called internally on WS updates. */
function recomputeDiff(nodes: GraphNode[], edges: GraphEdge[]): void {
  if (!state.baseSnapshot) return
  setState('currentDiff', computeArchDiff(state.baseSnapshot, { nodes, edges }))
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

  // 1b. Apply test-file filter — matches .test.* / .spec.* / __tests__ / __mocks__ / .stories.*
  if (state.hideTestFiles) {
    const TEST_RE = /(\.(test|spec)\.[jt]sx?$|__tests__[\\/]|__mocks__[\\/]|\.stories\.[jt]sx?$)/i
    nodes = nodes.filter((n) => !TEST_RE.test(n.filePath ?? ''))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 1b2. Apply dev-file filter — package manifests, lock files, config files,
  //      toolchain configs, CI/CD directories, env files, and docs.
  //      Combined with the test filter, what remains is pure application source.
  if (state.hideDevFiles) {
    // Directory segments that are never source: node_modules, .git, .github, etc.
    const DEV_DIR_RE =
      /[\\/](node_modules|\.git|\.github|\.circleci|\.gitlab|dist|build|coverage|\.next|\.nuxt|\.output|\.cache)[\\/]/i
    // Individual files by name/extension at any depth
    const DEV_FILE_RE =
      /([\\/]|^)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb|[^/\\]+\.config\.[cm]?[jt]sx?|tsconfig[^/\\]*\.json|jsconfig[^/\\]*\.json|\.eslintrc[^/\\]*|\.prettierrc[^/\\]*|\.stylelintrc[^/\\]*|\.babelrc[^/\\]*|\.editorconfig|\.browserslistrc|Dockerfile[^/\\]*|docker-compose[^/\\]*|\.dockerignore|\.env(\.[^/\\]*)?|Makefile|Jenkinsfile|\.nvmrc|\.node-version|\.tool-versions|\.gitignore|\.gitattributes|\.npmignore|\.npmrc|README[^/\\]*|LICENSE[^/\\]*|CHANGELOG[^/\\]*|CONTRIBUTING[^/\\]*)$/i
    nodes = nodes.filter((n) => {
      const fp = n.filePath ?? ''
      return !DEV_DIR_RE.test(fp) && !DEV_FILE_RE.test(fp)
    })
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 1c. When grouping by file, contract, or package, remove file-kind nodes —
  //     they become spatial containers drawn in the canvas layer, not graph nodes.
  if (state.groupByFile || state.groupByContract || state.groupByPackage) {
    nodes = nodes.filter((n) => n.kind !== 'file')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // When grouping by class, remove class-kind nodes — they become spatial
  // containers holding their method/property children. Applies whether or not
  // file grouping is also on; when both are active, class containers appear as
  // sub-compounds nested inside file containers.
  if (state.groupByClass) {
    nodes = nodes.filter((n) => n.kind !== 'class')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 1d. Elevate import nodes to direct edges — strip all import-kind nodes from
  //     the visible graph and replace each with synthetic `imports` edges that
  //     connect the containing file/module directly to the import target.
  //     "file → contains → import:X → imports → target" becomes
  //     "file → imports → target", making module dependencies first-class links.
  const syntheticImportEdges: GraphEdge[] = []
  {
    const importIds = new Set<string>()
    for (const n of nodes) {
      if (n.kind === 'import') importIds.add(n.id)
    }

    if (importIds.size > 0) {
      // Gather the file(s) that contain each import node and the target(s) it imports.
      const importContainers = new Map<string, Set<string>>() // importId → container ids
      const importTargets = new Map<string, Set<string>>() // importId → target ids

      for (const e of state.edges) {
        if (e.kind === 'contains' && importIds.has(e.target)) {
          if (!importContainers.has(e.target)) importContainers.set(e.target, new Set())
          importContainers.get(e.target)!.add(e.source)
        }
        if (e.kind === 'imports' && importIds.has(e.source)) {
          if (!importTargets.has(e.source)) importTargets.set(e.source, new Set())
          importTargets.get(e.source)!.add(e.target)
        }
      }

      // Synthesise file → imports → target edges
      for (const [importId, containerIds] of importContainers) {
        const targetIds = importTargets.get(importId)
        if (!targetIds) continue
        for (const cid of containerIds) {
          for (const tid of targetIds) {
            if (nodeIds.has(cid) && nodeIds.has(tid) && cid !== tid) {
              syntheticImportEdges.push({ source: cid, target: tid, kind: 'imports' })
            }
          }
        }
      }

      // Remove import nodes from the visible set
      nodes = nodes.filter((n) => !importIds.has(n.id))
      nodeIds = new Set(nodes.map((n) => n.id))
    }
  }

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

  // 3. Filter edges: kind not hidden, both endpoints visible, deduplicated by
  //     (src, tgt, kind). Import nodes were removed in step 1d, so any edge
  //     that referenced one will fail the nodeIds check and be dropped naturally.
  //     Synthetic import-elevation edges are merged in after.
  const seenEdgeKeys = new Set<string>()
  const edges: GraphEdge[] = []

  for (const e of state.edges) {
    if (hiddenEdgeSet.has(e.kind)) continue
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source}|${e.target}|${e.kind}`
    if (seenEdgeKeys.has(key)) continue
    seenEdgeKeys.add(key)
    edges.push(e)
  }

  // Merge synthetic import edges (deduplicate against regular edges too)
  for (const e of syntheticImportEdges) {
    const key = `${e.source}|${e.target}|${e.kind}`
    if (!seenEdgeKeys.has(key)) {
      seenEdgeKeys.add(key)
      edges.push(e)
    }
  }

  return { nodes, edges }
}

// ── Project ───────────────────────────────────────────────────────────────────

export async function openProject(projectRoot: string): Promise<void> {
  // Clear stale nodes immediately so we never show a previous project's layout
  // while waiting for the new project's graph data to arrive.
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
    let nodes: typeof state.nodes
    let edges: typeof state.edges
    if (mode === 'call-graph' && state.selectedNodeId) {
      const subgraph = await api.fetchCallGraph(state.selectedNodeId)
      nodes = subgraph.nodes
      edges = subgraph.edges
    } else if (mode === 'impact-radius' && state.selectedNodeId) {
      const subgraph = await api.fetchImpactRadius(state.selectedNodeId)
      nodes = subgraph.nodes
      edges = subgraph.edges
    } else {
      const graph = await api.fetchGraph()
      nodes = graph.nodes
      edges = graph.edges
    }
    setState('nodes', nodes)
    setState('edges', edges)
    recomputeDiff(nodes, edges)
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
        recomputeDiff(graph.nodes, graph.edges)
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
