import * as api from '../api/graph.js'
import { setState } from './core.js'
import { recomputeDiff } from './diff.js'

// ── View ──────────────────────────────────────────────────────────────────────

/** Re-fetch the full graph from the server and update state. */
export async function reloadGraph(): Promise<void> {
  try {
    const graph = await api.fetchGraph()
    setState('nodes', graph.nodes)
    setState('edges', graph.edges)
    recomputeDiff(graph.nodes, graph.edges)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to load graph')
  }
}
