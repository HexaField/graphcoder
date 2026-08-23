import { createStore } from 'solid-js/store'
import { loadFilters } from './storage.js'
import type { AppState } from './types.js'

const _saved = loadFilters()

/**
 * The single SolidJS store for all app state.
 *
 * `state` and `setState` are intentionally the only exports from this module —
 * all domain logic lives in the per-section files (project, filters, diff, …)
 * which import these two primitives and close over them.
 */
export const [state, setState] = createStore<AppState>({
  // Project
  projectRoot: null,
  projectStats: null,
  isLoading: false,
  error: null,

  // Graph
  nodes: [],
  edges: [],

  // Selection
  selectedNodeId: null,
  selectedNodeDetail: null,
  isLoadingDetail: false,

  // View
  viewMode: 'module-dependency',

  // Filters & focus
  hiddenNodeKinds: _saved.hiddenNodeKinds ?? [],
  hiddenEdgeKinds: _saved.hiddenEdgeKinds ?? [],
  hideTestFiles: _saved.hideTestFiles ?? false,
  hideDevFiles: _saved.hideDevFiles ?? false,
  groupByFile: _saved.groupByFile ?? false,
  groupByContract: _saved.groupByContract ?? false,
  groupByClass: _saved.groupByClass ?? false,
  groupByPackage: _saved.groupByPackage ?? false,
  focusedNodeId: null,

  // Diff
  baseSnapshot: null,
  currentDiff: null,

  // Search
  searchQuery: '',
  searchResults: [],
  isSearching: false
})
