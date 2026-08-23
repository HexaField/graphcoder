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

// ── Project ───────────────────────────────────────────────────────────────────

export interface ProjectState {
  projectRoot: string | null
  projectStats: ProjectStats | null
  isLoading: boolean
  error: string | null
}

// ── Graph ─────────────────────────────────────────────────────────────────────

export interface GraphState {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── Selection ─────────────────────────────────────────────────────────────────

export interface SelectionState {
  selectedNodeId: string | null
  selectedNodeDetail: NodeDetail | null
  isLoadingDetail: boolean
}

// ── View ──────────────────────────────────────────────────────────────────────

export interface ViewState {
  viewMode: ViewMode
}

// ── Filters & focus ───────────────────────────────────────────────────────────

export interface FiltersState {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  hideTestFiles: boolean
  hideDevFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  focusedNodeId: string | null
}

export interface PersistedFilters {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  hideTestFiles: boolean
  hideDevFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export interface DiffState {
  baseSnapshot: GraphSnapshot | null
  currentDiff: ArchDiff | null
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchState {
  searchQuery: string
  searchResults: { node: GraphNode; score: number }[]
  isSearching: boolean
}

// ── Composed ──────────────────────────────────────────────────────────────────

export type AppState = ProjectState & GraphState & SelectionState & ViewState & FiltersState & DiffState & SearchState
