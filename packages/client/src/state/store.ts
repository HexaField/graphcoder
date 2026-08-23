/**
 * Public API barrel for the app store.
 *
 * All components and hooks import from this module — the internal split across
 * core / diff / filters / project / selection / view / search is an
 * implementation detail.
 */

// Core state (reactive SolidJS store proxy + setter) + composed AppState type
export { state, setState } from './core.js'
export type { AppState } from './core.js'

// Section: Diff
export { captureSnapshot, clearDiff } from './diff.js'
export type { DiffState } from './diff.js'

// Section: Filters & focus
export {
  clearFilters,
  clearFocus,
  globToRegex,
  setExcludePatterns,
  setFocus,
  setGraphDirection,
  toggleEdgeKind,
  toggleGroupByClass,
  toggleGroupByContract,
  toggleGroupByFile,
  toggleGroupByPackage,
  toggleNodeKind,
  visibleGraph
} from './filters.js'
export type { FiltersState } from './filters.js'

// Section: Graph  (nodes + edges managed by project / view / websocket)
export type { GraphState } from './graph.js'

// Section: Project
export { connectWebSocket, initFromUrl, openProject } from './project.js'
export type { ProjectState } from './project.js'

// Section: Search
export { search } from './search.js'
export type { SearchState } from './search.js'

// Section: Selection
export { clearSelection, selectNode } from './selection.js'
export type { SelectionState } from './selection.js'

// Section: Storage  (PersistedFilters lives here — it owns the serialisation schema)
export type { PersistedFilters } from './storage.js'
export type { GraphDirection } from '@graphcoder/core'

// Section: View
export { reloadGraph } from './view.js'

// Section: Hierarchy
export {
  addGroupExpanded,
  clearHierarchyHidden,
  collapseAllGroups,
  expandAllGroups,
  setHiddenPaths,
  toggleGroupExpanded,
  toggleHierarchyHidden
} from './hierarchy.js'
export type { HierarchyState } from './hierarchy.js'

// Section: Temporal (git history bar + commit-range diff)
export {
  loadCommits,
  refreshGitStatus,
  runTemporalDiff,
  setActiveTab,
  setBaseRef,
  setBranchRef,
  setTargetRef,
  toggleGitBar
} from './temporal.js'
export type { TemporalRange, TemporalState } from './temporal.js'

// Utilities
export { syncUrlParams } from './url.js'
