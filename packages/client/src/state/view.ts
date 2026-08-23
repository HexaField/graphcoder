import type { ViewMode } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { state, setState } from './core.js'
import { recomputeDiff } from './diff.js'
import { syncUrlParams } from './url.js'

// ── View ──────────────────────────────────────────────────────────────────────

/**
 * Switch the active view mode. Fetches the appropriate graph data for the
 * new mode (call-graph and impact-radius operate on the selected node; all
 * other modes fetch the full module-dependency graph).
 */
export async function setViewMode(mode: ViewMode): Promise<void> {
  setState('viewMode', mode)
  syncUrlParams()
  try {
    let nodes: typeof state.nodes
    let edges: typeof state.edges
    if (mode === 'call-graph' && state.selectedNodeId) {
      const subgraph = await api.fetchCallGraph(state.selectedNodeId)
      nodes = subgraph.nodes
      edges = subgraph.edges
    } else if (mode === 'impact-radius' && state.selectedNodeId) {
      const subgraph = await api.fetchImpactRadius(state.selectedNodeId)
      nodes = subgraph.nodes
      edges = subgraph.edges
    } else {
      const graph = await api.fetchGraph()
      nodes = graph.nodes
      edges = graph.edges
    }
    setState('nodes', nodes)
    setState('edges', edges)
    recomputeDiff(nodes, edges)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to load graph')
  }
}
