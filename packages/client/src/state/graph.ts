import type { FileGroup, GraphEdge, GraphNode } from '@graphcoder/core'

// ── Graph ─────────────────────────────────────────────────────────────────────

/**
 * Graph state — view snapshots received from the server.
 *
 * The client never stores the raw graph; the server applies all filtering
 * and group computation via computeView() and sends only what ELK needs.
 */
export interface GraphState {
  /** Layout-ready symbol nodes — server has excluded collapsed children. */
  viewNodes: GraphNode[]
  /** Layout-ready edges — server has promoted collapsed-group endpoints. */
  viewEdges: GraphEdge[]
  /** ELK compound group hierarchy — ready to pass straight to layoutGraph(). */
  viewGroups: FileGroup[]
  /**
   * All file/module nodes in the project — used by the HierarchyPanel sidebar
   * to build the directory/package tree. Independent of view params.
   */
  fileNodes: GraphNode[]
}

export { state, setState } from './core.js'
