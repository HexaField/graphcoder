import type { GraphEdge, NodeDetail } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { state, setState } from './core.js'

// ── Selection ─────────────────────────────────────────────────────────────────

export interface SelectionState {
  selectedNodeId: string | null
  selectedNodeDetail: NodeDetail | null
  isLoadingDetail: boolean
}

/**
 * Build a NodeDetail from the local diff view data.
 *
 * Called as a fallback when the REST endpoint cannot resolve a CodeGraph ID
 * from a historical commit. The merged diff nodes/edges already contain
 * the information — only the source `code` string stays unavailable.
 */
function buildLocalDetail(nodeId: string): NodeDetail | null {
  const raw = state.rawDiffView
  if (!raw) return null
  const node = raw.nodes.find((n) => n.id === nodeId)
  if (!node) return null

  const incoming: GraphEdge[] = []
  const outgoing: GraphEdge[] = []
  for (const e of raw.edges) {
    if (e.target === nodeId) incoming.push(e)
    if (e.source === nodeId) outgoing.push(e)
  }
  return { node, incoming, outgoing, code: null }
}

/**
 * Select a node by ID and fetch its full detail from the server.
 * Clears any stale detail before the request resolves.
 *
 * During a temporal diff the view uses semantic IDs while the REST API
 * returns edges keyed by CodeGraph IDs (HEAD topology). Those CG IDs
 * don't match the diff canvas, so the inspector would show wrong
 * connections. Fix: when a diff occupies the display, build the node
 * detail from local diff data (correct semantic IDs for all edges).
 * The REST call still runs as an optional enrichment for source code.
 */
export async function selectNode(nodeId: string): Promise<void> {
  setState('selectedNodeId', nodeId)
  setState('selectedNodeDetail', null)
  setState('isLoadingDetail', true)

  try {
    // When a diff is active, the local data has the authoritative topology
    // (edges use semantic IDs matching the canvas). REST returns HEAD's
    // topology with CG IDs — wrong for the diff context.
    if (state.rawDiffView) {
      const local = buildLocalDetail(nodeId)
      if (local) {
        // Optionally enrich with source code from the REST endpoint.
        const cgMap = state.diffCgIdMap
        const resolvedId = cgMap?.get(nodeId) ?? nodeId
        try {
          const rest = await api.fetchNodeDetail(resolvedId)
          if (rest.code) local.code = rest.code
        } catch {
          // Code unavailable for historical nodes — local detail still valid.
        }
        setState('selectedNodeDetail', local)
        return
      }
    }

    // Normal (non-diff) path — REST is authoritative.
    const detail = await api.fetchNodeDetail(nodeId)
    setState('selectedNodeDetail', detail)
  } catch {
    const local = buildLocalDetail(nodeId)
    if (local) {
      setState('selectedNodeDetail', local)
    } else {
      setState('error', `Node ${nodeId} not found`)
    }
  } finally {
    setState('isLoadingDetail', false)
  }
}

/** Deselect the current node and discard any loaded detail. */
export function clearSelection(): void {
  setState('selectedNodeId', null)
  setState('selectedNodeDetail', null)
}
