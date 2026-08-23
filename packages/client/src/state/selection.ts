import type { NodeDetail } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { setState } from './core.js'

// ── Selection ─────────────────────────────────────────────────────────────────

export interface SelectionState {
  selectedNodeId: string | null
  selectedNodeDetail: NodeDetail | null
  isLoadingDetail: boolean
}

/**
 * Select a node by ID and fetch its full detail from the server.
 * Clears any stale detail before the request resolves.
 */
export async function selectNode(nodeId: string): Promise<void> {
  setState('selectedNodeId', nodeId)
  setState('selectedNodeDetail', null)
  setState('isLoadingDetail', true)
  try {
    const detail = await api.fetchNodeDetail(nodeId)
    setState('selectedNodeDetail', detail)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Failed to load node detail')
  } finally {
    setState('isLoadingDetail', false)
  }
}

/** Deselect the current node and discard any loaded detail. */
export function clearSelection(): void {
  setState('selectedNodeId', null)
  setState('selectedNodeDetail', null)
}
