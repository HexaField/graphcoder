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
  toggleNodeKind
} from './filters.js'
export type { FiltersState } from './filters.js'

// Section: Graph  (view snapshots from server)
export type { GraphState } from './graph.js'

// Section: Project
export { connectWebSocket, initFromUrl, openProject, sendViewRequest } from './project.js'
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

// Section: Hierarchy
export {
  addGroupExpanded,
  clearHierarchyHidden,
  collapseAllGroups,
  collapseGroup,
  expandAllGroups,
  setHiddenPaths,
  toggleGroupExpanded,
  toggleHierarchyHidden
} from './hierarchy.js'
export type { HierarchyState } from './hierarchy.js'

// Section: Temporal (git graph DAG + commit-pair diff)
export {
  clearSelection as clearGraphSelection,
  loadGitGraph,
  refilterDiffView,
  refreshGitStatus,
  runTemporalDiff,
  selectCommit,
  swapRefs,
  toggleBranchExpanded,
  toggleGitBar
} from './temporal.js'
export type { TemporalRange, TemporalState } from './temporal.js'

// Section: Annotations
export {
  addAnnotation,
  loadAnnotations,
  patchAnnotation,
  removeAnnotation,
  selectAnnotation,
  requestSuggest,
  removeSuggestingId,
  startRefinement,
  stopRefinement,
  sendRefinement,
  acceptAnnotation,
  dismissAnnotation,
  loadProviders,
  setSelectedProvider
} from './annotations.js'
export type { AnnotationsState } from './annotations.js'

// Utilities
export { syncUrlParams } from './url.js'
