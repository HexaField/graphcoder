import { createStore } from 'solid-js/store'
import { loadFilters, loadHierarchy } from './storage.js'

// `import type` is erased at build time — no runtime circular dependency.
import type { DiffState } from './diff.js'
import type { FiltersState } from './filters.js'
import type { GraphState } from './graph.js'
import type { HierarchyState } from './hierarchy.js'
import type { ProjectState } from './project.js'
import type { SearchState } from './search.js'
import type { SelectionState } from './selection.js'
import type { TemporalState } from './temporal.js'
import { temporalInitial } from './temporal.js'

/**
 * Full application state — the intersection of every section's slice type.
 *
 * Slice types live in their respective section files (project.ts, filters.ts, …).
 * This composed type is exported for the rare consumer that needs the full shape.
 */
export type AppState = ProjectState &
  GraphState &
  SelectionState &
  FiltersState &
  DiffState &
  SearchState &
  HierarchyState &
  TemporalState

const _saved = loadFilters()
const _savedHierarchy = loadHierarchy()

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

  // Filters & focus
  hiddenNodeKinds: _saved.hiddenNodeKinds ?? [],
  hiddenEdgeKinds: _saved.hiddenEdgeKinds ?? [],
  excludePatterns: _saved.excludePatterns ?? '',
  groupByFile: _saved.groupByFile ?? false,
  groupByContract: _saved.groupByContract ?? false,
  groupByClass: _saved.groupByClass ?? false,
  groupByPackage: _saved.groupByPackage ?? false,
  focusedNodeId: null,
  graphDirection: _saved.graphDirection ?? 'TB',

  // Diff
  baseSnapshot: null,
  currentDiff: null,

  // Search
  searchQuery: '',
  searchResults: [],
  isSearching: false,

  // Hierarchy
  hiddenPaths: _savedHierarchy.hiddenPaths ?? [],

  // Temporal (git history bar + commit-range diff)
  ...temporalInitial
})
