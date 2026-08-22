import type { GraphEdge, GraphNode, GraphSnapshot } from '../index.js'
import { nodeSemanticId } from '../identity.js'
import { snapshotHash } from './hash.js'
import type { ArchDiff, NodeSnapshot } from './types.js'

function snapshotToNode(snap: NodeSnapshot): GraphNode {
  return {
    id: snap.id,
    kind: snap.kind,
    name: snap.name,
    qualifiedName: snap.qualifiedName,
    filePath: snap.filePath,
    language: snap.language,
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    signature: snap.signature,
    visibility: snap.visibility,
    isExported: snap.isExported,
    isAsync: snap.isAsync,
    isStatic: snap.isStatic,
    isAbstract: snap.isAbstract,
    returnType: snap.returnType,
    decorators: snap.decorators,
    typeParameters: snap.typeParameters,
    updatedAt: Date.now()
  }
}

export function applyArchDiff(snapshot: GraphSnapshot, diff: ArchDiff): GraphSnapshot {
  const actualBase = snapshotHash(snapshot)
  if (actualBase !== diff.base) {
    throw new Error(`ArchDiff base mismatch: diff expects ${diff.base}, snapshot hashes to ${actualBase}`)
  }

  const nodesBySemId = new Map<string, GraphNode>()
  const cgToSemId = new Map<string, string>()

  for (const n of snapshot.nodes) {
    const sid = nodeSemanticId(n)
    nodesBySemId.set(sid, n)
    cgToSemId.set(n.id, sid)
  }

  for (const op of diff.operations) {
    switch (op.op) {
      case 'remove_edge':
        break
      case 'remove_node':
        nodesBySemId.delete(op.id)
        break
      case 'modify_node': {
        const existing = nodesBySemId.get(op.id)
        if (existing) nodesBySemId.set(op.id, { ...existing, ...op.next })
        break
      }
      case 'move_node': {
        const existing = nodesBySemId.get(op.id)
        if (existing) nodesBySemId.set(op.id, { ...existing, filePath: op.to.filePath })
        break
      }
      case 'add_node':
        nodesBySemId.set(op.node.id, snapshotToNode(op.node))
        break
      case 'add_edge':
        break
    }
  }

  const outputNodes = [...nodesBySemId.values()]
  const outputSemIds = new Set(nodesBySemId.keys())

  const removeEdgeKeys = new Set(
    diff.operations
      .filter((o): o is Extract<typeof o, { op: 'remove_edge' }> => o.op === 'remove_edge')
      .map((o) => `${o.edge.source}|${o.edge.target}|${o.edge.kind}`)
  )

  const outputEdgeKeys = new Set<string>()
  const outputEdges: GraphEdge[] = []

  for (const e of snapshot.edges) {
    const srcSem = cgToSemId.get(e.source) ?? e.source
    const tgtSem = cgToSemId.get(e.target) ?? e.target
    const key = `${srcSem}|${tgtSem}|${e.kind}`
    if (!removeEdgeKeys.has(key) && !outputEdgeKeys.has(key)) {
      if (outputSemIds.has(srcSem) && outputSemIds.has(tgtSem)) {
        outputEdgeKeys.add(key)
        outputEdges.push({ ...e, source: srcSem, target: tgtSem })
      }
    }
  }

  for (const op of diff.operations) {
    if (op.op !== 'add_edge') continue
    const key = `${op.edge.source}|${op.edge.target}|${op.edge.kind}`
    if (!outputEdgeKeys.has(key) && outputSemIds.has(op.edge.source) && outputSemIds.has(op.edge.target)) {
      outputEdgeKeys.add(key)
      outputEdges.push({ source: op.edge.source, target: op.edge.target, kind: op.edge.kind })
    }
  }

  return { nodes: outputNodes, edges: outputEdges }
}
