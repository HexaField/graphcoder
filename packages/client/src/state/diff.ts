import type { ArchDiff, GraphEdge, GraphNode, GraphSnapshot } from '@graphcoder/core'
import { computeArchDiff } from '@graphcoder/core'
import { state, setState } from './core.js'

// ── Diff ──────────────────────────────────────────────────────────────────────

export interface DiffState {
  baseSnapshot: GraphSnapshot | null
  currentDiff: ArchDiff | null
}

/** Capture the current graph as the diff baseline. */
export function captureSnapshot(): void {
  setState('baseSnapshot', { nodes: [...state.nodes], edges: [...state.edges] })
  setState('currentDiff', null)
  // Clear any temporal range label — switching to snapshot mode.
  setState('temporalRange', null)
}

/** Discard the baseline and clear any computed diff. */
export function clearDiff(): void {
  setState('baseSnapshot', null)
  setState('currentDiff', null)
  setState('temporalRange', null)
}

/**
 * Recompute the diff against the stored baseline using the supplied nodes and
 * edges. No-ops when no baseline has been captured.
 *
 * Called internally by project, view, and WebSocket handlers whenever the
 * graph changes — not part of the public API surface.
 */
export function recomputeDiff(nodes: GraphNode[], edges: GraphEdge[]): void {
  if (!state.baseSnapshot) return
  setState('currentDiff', computeArchDiff(state.baseSnapshot, { nodes, edges }))
}
