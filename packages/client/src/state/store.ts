/**
 * Public API barrel for the app store.
 *
 * All components and hooks import from this module — the internal split across
 * core / diff / filters / project / selection / view / search is an
 * implementation detail.
 */

// Core state (reactive SolidJS store proxy + setter)
export { state, setState } from './core.js'

// Section: Graph  (nodes + edges managed by project / view / websocket)
export { state as graphState } from './graph.js'

// Section: Diff
export { captureSnapshot, clearDiff } from './diff.js'

// Section: Filters & focus
export {
  clearFilters,
  clearFocus,
  setFocus,
  toggleEdgeKind,
  toggleGroupByClass,
  toggleGroupByContract,
  toggleGroupByFile,
  toggleGroupByPackage,
  toggleHideDevFiles,
  toggleHideTestFiles,
  toggleNodeKind,
  visibleGraph
} from './filters.js'

// Section: Project
export { connectWebSocket, initFromUrl, openProject } from './project.js'

// Section: Search
export { search } from './search.js'

// Section: Selection
export { clearSelection, selectNode } from './selection.js'

// Section: View
export { setViewMode } from './view.js'

// Utilities
export { VIEW_MODES } from './url.js'

// Types (re-exported so consumers don't need to know the internal layout)
export type {
  AppState,
  DiffState,
  FiltersState,
  GraphState,
  PersistedFilters,
  ProjectState,
  SearchState,
  SelectionState,
  ViewState
} from './types.js'
