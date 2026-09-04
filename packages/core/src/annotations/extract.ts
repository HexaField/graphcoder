import type { GraphEdge, GraphNode } from '../index.js'
import type { PathStep, StepEdge } from './types.js'

export interface ExtractedPath {
  steps: PathStep[]
  stepEdges: StepEdge[]
  members: string[]
}

export function buildPathFromNodes(orderedNodes: GraphNode[], connectingEdges: GraphEdge[]): ExtractedPath {
  const steps: PathStep[] = orderedNodes.map((node, i) => ({
    id: `step-${i}`,
    label: node.name,
    description: `${node.kind}: ${node.qualifiedName}`,
    architectureNodeId: null,
    stepKind: i === 0 ? 'entry' : i === orderedNodes.length - 1 ? 'exit' : 'process'
  }))

  const nodeIdToStepIdx = new Map<string, number>()
  for (let i = 0; i < orderedNodes.length; i++) {
    nodeIdToStepIdx.set(orderedNodes[i].id, i)
  }

  const stepEdges: StepEdge[] = []
  for (const edge of connectingEdges) {
    const fromIdx = nodeIdToStepIdx.get(edge.source)
    const toIdx = nodeIdToStepIdx.get(edge.target)
    if (fromIdx !== undefined && toIdx !== undefined) {
      stepEdges.push({
        from: steps[fromIdx].id,
        to: steps[toIdx].id,
        label: edge.kind
      })
    }
  }

  if (stepEdges.length === 0) {
    for (let i = 0; i < steps.length - 1; i++) {
      stepEdges.push({
        from: steps[i].id,
        to: steps[i + 1].id,
        label: null
      })
    }
  }

  return {
    steps,
    stepEdges,
    members: orderedNodes.map((n) => n.id)
  }
}
