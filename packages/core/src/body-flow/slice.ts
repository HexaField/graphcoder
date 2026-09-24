import type { TracedFlow } from '../flow/types.js'
import type { BodyFlow, CFNode } from './types.js'

export interface BodyFlowSlice {
  nodeIds: Set<string>
  /** Indices into `BodyFlow.edges` */
  edgeIndices: Set<number>
  /** Call or block nodes on the slice that invoke a target */
  hitNodeIds: Set<string>
}

/** Functions a traced flow steps to directly from `functionNodeId`. */
export function flowSuccessors(flows: readonly TracedFlow[], functionNodeId: string): Set<string> {
  const ids = new Set<string>()
  for (const flow of flows) {
    for (const edge of flow.edges) {
      if (edge.source === functionNodeId) ids.add(edge.target)
    }
  }
  return ids
}

function callsAny(node: CFNode, targetIds: ReadonlySet<string>): boolean {
  if (node.targetNodeId != null && targetIds.has(node.targetNodeId)) return true
  return node.calls?.some((c) => c.targetNodeId != null && targetIds.has(c.targetNodeId)) ?? false
}

function reach(starts: string[], adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set(starts)
  const stack = [...starts]
  while (stack.length > 0) {
    for (const next of adjacency.get(stack.pop()!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return seen
}

/**
 * The part of a body flow on some path from entry to a call of any target function.
 * Returns null when no reachable call invokes a target.
 */
export function sliceBodyFlow(flow: BodyFlow, targetIds: ReadonlySet<string>): BodyFlowSlice | null {
  const entry = flow.nodes.find((n) => n.kind === 'entry')
  const hits = flow.nodes.filter((n) => callsAny(n, targetIds)).map((n) => n.id)
  if (!entry || hits.length === 0) return null

  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const e of flow.edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target])
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source])
  }

  const forward = reach([entry.id], outgoing)
  const hitNodeIds = new Set(hits.filter((id) => forward.has(id)))
  if (hitNodeIds.size === 0) return null

  const backward = reach([...hitNodeIds], incoming)
  const nodeIds = new Set([...forward].filter((id) => backward.has(id)))
  const edgeIndices = new Set<number>()
  flow.edges.forEach((e, i) => {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) edgeIndices.add(i)
  })

  return { nodeIds, edgeIndices, hitNodeIds }
}
