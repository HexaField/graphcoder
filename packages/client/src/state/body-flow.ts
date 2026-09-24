import type { BodyFlow } from '@graphcoder/core'
import { state, setState } from './core.js'
import * as flowApi from '../api/flow.js'

export interface BodyFlowState {
  expandedBodyFlows: Set<string>
  bodyFlowData: Map<string, BodyFlow>
  bodyFlowLoading: Set<string>
  bodyFlowError: string | null
}

export const bodyFlowInitial: BodyFlowState = {
  expandedBodyFlows: new Set(),
  bodyFlowData: new Map(),
  bodyFlowLoading: new Set(),
  bodyFlowError: null
}

export async function toggleBodyFlow(nodeId: string): Promise<void> {
  const expanded = state.expandedBodyFlows
  if (expanded.has(nodeId)) {
    const next = new Set(expanded)
    next.delete(nodeId)
    setState('expandedBodyFlows', next)
    return
  }

  if (state.bodyFlowData.has(nodeId)) {
    setState('expandedBodyFlows', new Set([...expanded, nodeId]))
    return
  }

  const loading = new Set(state.bodyFlowLoading)
  loading.add(nodeId)
  setState('bodyFlowLoading', loading)
  setState('bodyFlowError', null)

  try {
    const bodyFlow = await flowApi.fetchBodyFlow(nodeId)
    const nextData = new Map(state.bodyFlowData)
    nextData.set(nodeId, bodyFlow)
    setState('bodyFlowData', nextData)
    setState('expandedBodyFlows', new Set([...state.expandedBodyFlows, nodeId]))
  } catch (e) {
    setState('bodyFlowError', e instanceof Error ? e.message : 'Failed to load body flow')
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
