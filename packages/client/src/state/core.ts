import { createStore } from 'solid-js/store'
import { loadFilters } from './storage.js'

// `import type` is erased at build time — no runtime circular dependency.
import type { DiffState } from './diff.js'
import type { FiltersState } from './filters.js'
import type { GraphState } from './graph.js'
import type { HierarchyState } from './hierarchy.js'
import type { ProjectState } from './project.js'
import type { SearchState } from './search.js'
import type { SelectionState } from './selection.js'
import type { ViewState } from './view.js'

/**
 * Full application state — the intersection of every section's slice type.
 *
 * Slice types live in their respective section files (project.ts, filters.ts, …).
 * This composed type is exported for the rare consumer that needs the full shape.
 */
export type AppState = ProjectState &
  GraphState &
  SelectionState &
  ViewState &
  FiltersState &
  DiffState &
  SearchState &
  HierarchyState

const _saved = loadFilters()

/**
 * The single SolidJS store for all app state.
 *
 * `state` and `setState` are the only runtime exports from this module — all
 * domain logic lives in the per-section files (project, filters, diff, …)
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
  isSearching: false,

  // Hierarchy
  hiddenPaths: []
})
