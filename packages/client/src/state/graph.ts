import type { GraphEdge, GraphNode } from '@graphcoder/core'

// ── Graph ─────────────────────────────────────────────────────────────────────

/**
 * Graph state — nodes and edges are managed by the project, view, and
 * WebSocket sections. This section owns the type definition and re-exports
 * the core store for consumers that need raw graph access without pulling in
 * unrelated sections.
 */
export interface GraphState {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export { state, setState } from './core.js'
