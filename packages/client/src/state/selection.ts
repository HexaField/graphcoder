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
 * During a temporal diff the view uses semantic IDs. The REST API expects
 * CodeGraph IDs, so we resolve through the reverse map first. If the
 * server returns 404 (the historical ID no longer exists at HEAD), we
 * fall back to building a detail object from the local diff data.
 */
export async function selectNode(nodeId: string): Promise<void> {
  setState('selectedNodeId', nodeId)
  setState('selectedNodeDetail', null)
  setState('isLoadingDetail', true)

  const cgMap = state.diffCgIdMap
  const resolvedId = cgMap?.get(nodeId) ?? nodeId

  try {
    const detail = await api.fetchNodeDetail(resolvedId)
    setState('selectedNodeDetail', detail)
  } catch {
    // When the REST lookup fails during a diff view, fall back to local data.
    const local = buildLocalDetail(nodeId)
    if (local) {
      setState('selectedNodeDetail', local)
    } else {
      setState('error', `Node ${resolvedId} not found`)
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
