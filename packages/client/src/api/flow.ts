import type { EntryPoint, TracedFlow, FlowTracerConfig, BodyFlow } from '@graphcoder/core'
import { API_BASE as API } from '../config.js'

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      message = body.error ?? message
    } catch {
      // ignore
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function fetchEntryPoints(): Promise<EntryPoint[]> {
  const res = await fetch(`${API}/api/graph/entry-points`)
  const data = await handleResponse<{ entryPoints: EntryPoint[] }>(res)
  return data.entryPoints
}

export async function fetchTraceFlow(nodeId: string, config?: Partial<FlowTracerConfig>): Promise<TracedFlow> {
  const res = await fetch(`${API}/api/graph/trace-flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, config })
  })
  const data = await handleResponse<{ flow: TracedFlow }>(res)
  return data.flow
}

export async function fetchTraceFlowReverse(nodeId: string, config?: Partial<FlowTracerConfig>): Promise<TracedFlow[]> {
  const res = await fetch(`${API}/api/graph/trace-flow-reverse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, config })
  })
  const data = await handleResponse<{ flows: TracedFlow[] }>(res)
  return data.flows
}

export interface ConvergenceEntry {
  nodeId: string
  count: number
}

export async function fetchConvergence(flowNodeIds: string[][], minFlowCount = 2): Promise<ConvergenceEntry[]> {
  const res = await fetch(`${API}/api/graph/convergence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowNodeIds, minFlowCount })
  })
  const data = await handleResponse<{ convergence: ConvergenceEntry[] }>(res)
  return data.convergence
}

export async function fetchBodyFlow(nodeId: string): Promise<BodyFlow> {
  const res = await fetch(`${API}/api/nodes/${encodeURIComponent(nodeId)}/body-flow`)
  const data = await handleResponse<{ bodyFlow: BodyFlow }>(res)
  return data.bodyFlow
}
