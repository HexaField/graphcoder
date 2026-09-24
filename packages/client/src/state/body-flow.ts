import type { BodyFlow } from '@graphcoder/core'
import { state, setState } from './core.js'
import * as flowApi from '../api/flow.js'

export interface BodyFlowState {
  expandedBodyFlows: Set<string>
  bodyFlowData: Map<string, BodyFlow>
  bodyFlowLoading: Set<string>
  bodyFlowError: { nodeId: string; message: string } | null
}

export const bodyFlowInitial: BodyFlowState = {
  expandedBodyFlows: new Set(),
  bodyFlowData: new Map(),
  bodyFlowLoading: new Set(),
  bodyFlowError: null
}

/** Expanding always refetches — the source may have changed since the last extraction. */
export async function toggleBodyFlow(nodeId: string): Promise<void> {
  if (state.expandedBodyFlows.has(nodeId)) {
    collapseBodyFlow(nodeId)
    return
  }

  setState('bodyFlowLoading', new Set([...state.bodyFlowLoading, nodeId]))
  setState('bodyFlowError', null)

  try {
    const bodyFlow = await flowApi.fetchBodyFlow(nodeId)
    setState('bodyFlowData', new Map(state.bodyFlowData).set(nodeId, bodyFlow))
    setState('expandedBodyFlows', new Set([...state.expandedBodyFlows, nodeId]))
  } catch (e) {
    setState('bodyFlowError', { nodeId, message: e instanceof Error ? e.message : 'Failed to load body flow' })
  } finally {
    const done = new Set(state.bodyFlowLoading)
    done.delete(nodeId)
    setState('bodyFlowLoading', done)
  }
}

export function collapseBodyFlow(nodeId: string): void {
  const next = new Set(state.expandedBodyFlows)
  next.delete(nodeId)
  setState('expandedBodyFlows', next)
}

export function collapseAllBodyFlows(): void {
  setState('expandedBodyFlows', new Set())
}
