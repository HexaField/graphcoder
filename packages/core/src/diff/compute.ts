import type { GraphSnapshot } from '../index.js'
import { nodeSemanticId } from '../identity.js'
import { computeDiffHash, snapshotHash } from './hash.js'
import type { ArchDiff, ArchOp, EdgeTuple, NodeProps, NodeSnapshot } from './types.js'

const OP_ORDER: Record<ArchOp['op'], number> = {
  remove_edge: 0,
  remove_node: 1,
  modify_node: 2,
  move_node: 3,
  add_node: 4,
  add_edge: 5
}

function edgeKey(e: EdgeTuple): string {
  return `${e.source}|${e.target}|${e.kind}`
}

export function sortOps(ops: ArchOp[]): ArchOp[] {
  return [...ops].sort((a, b) => {
    const orderDiff = OP_ORDER[a.op] - OP_ORDER[b.op]
    if (orderDiff !== 0) return orderDiff
    const aKey =
      a.op === 'add_node'
        ? a.node.id
        : a.op === 'remove_node' || a.op === 'modify_node' || a.op === 'move_node'
          ? a.id
          : edgeKey(a.edge)
    const bKey =
      b.op === 'add_node'
        ? b.node.id
        : b.op === 'remove_node' || b.op === 'modify_node' || b.op === 'move_node'
          ? b.id
          : edgeKey(b.edge)
    return aKey.localeCompare(bKey)
  })
}

function toNodeSnapshot(node: GraphSnapshot['nodes'][number], semId: string): NodeSnapshot {
  return {
    id: semId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    signature: node.signature,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
    returnType: node.returnType,
    decorators: node.decorators,
    typeParameters: node.typeParameters
  }
}

function diffNodeProps(
  base: GraphSnapshot['nodes'][number],
  target: GraphSnapshot['nodes'][number]
): { prev: Partial<NodeProps>; next: Partial<NodeProps> } | null {
  const fields: (keyof NodeProps)[] = [
    'qualifiedName',
    'filePath',
    'language',
    'visibility',
    'isExported',
    'isAsync',
    'isStatic',
    'isAbstract',
    'returnType',
    'decorators',
    'typeParameters'
  ]
  const prev: Partial<NodeProps> = {}
  const next: Partial<NodeProps> = {}
  let changed = false
  for (const f of fields) {
    const bv = base[f as keyof typeof base]
    const tv = target[f as keyof typeof target]
    if (JSON.stringify(bv) !== JSON.stringify(tv)) {
      ;(prev as Record<string, unknown>)[f] = bv
      ;(next as Record<string, unknown>)[f] = tv
      changed = true
    }
  }
  return changed ? { prev, next } : null
}

export function computeArchDiff(base: GraphSnapshot, target: GraphSnapshot): ArchDiff {
  const baseMap = new Map<string, (typeof base.nodes)[number]>()
  const targetMap = new Map<string, (typeof target.nodes)[number]>()
  const baseCgToSem = new Map<string, string>()
  const targetCgToSem = new Map<string, string>()

  for (const n of base.nodes) {
    const sid = nodeSemanticId(n)
    baseMap.set(sid, n)
    baseCgToSem.set(n.id, sid)
  }
  for (const n of target.nodes) {
    const sid = nodeSemanticId(n)
    targetMap.set(sid, n)
    targetCgToSem.set(n.id, sid)
  }

  const ops: ArchOp[] = []
  const removedSemIds = new Set<string>()
  const addedSemIds = new Set<string>()

  for (const [sid] of baseMap) {
    if (!targetMap.has(sid)) removedSemIds.add(sid)
  }
  for (const [sid] of targetMap) {
    if (!baseMap.has(sid)) addedSemIds.add(sid)
  }

  for (const [sid, baseNode] of baseMap) {
    const targetNode = targetMap.get(sid)
    if (!targetNode) continue
    const propDiff = diffNodeProps(baseNode, targetNode)
    if (propDiff === null) continue
    const onlyFilePath = Object.keys(propDiff.prev).length === 1 && 'filePath' in propDiff.prev
    if (onlyFilePath) {
      ops.push({
        op: 'move_node',
        id: sid,
        from: { filePath: baseNode.filePath },
        to: { filePath: targetNode.filePath }
      })
    } else {
      ops.push({ op: 'modify_node', id: sid, prev: propDiff.prev, next: propDiff.next })
    }
  }

  for (const sid of removedSemIds) {
    const n = baseMap.get(sid)!
    ops.push({ op: 'remove_node', id: sid, node: toNodeSnapshot(n, sid) })
  }

  const addedNodes = [...addedSemIds].map((sid) => ({ sid, node: targetMap.get(sid)! }))
  const removedNodesArr = [...removedSemIds].map((sid) => ({ sid, node: baseMap.get(sid)! }))

  for (const { sid: addedSid, node: addedNode } of addedNodes) {
    const snap = toNodeSnapshot(addedNode, addedSid)
    const renamedFrom = removedNodesArr.find(
      ({ node: removedNode }) =>
        removedNode.kind === addedNode.kind &&
        removedNode.filePath === addedNode.filePath &&
        Math.abs(removedNode.startLine - addedNode.startLine) <= 5
    )
    if (renamedFrom) {
      snap.properties = { ...snap.properties, renameOf: renamedFrom.sid }
    }
    ops.push({ op: 'add_node', node: snap })
  }

  const baseEdgeKeys = new Map<string, EdgeTuple>()
  const targetEdgeKeys = new Map<string, EdgeTuple>()

  for (const e of base.edges) {
    const srcSem = baseCgToSem.get(e.source)
    const tgtSem = baseCgToSem.get(e.target)
    if (!srcSem || !tgtSem) continue
    const et: EdgeTuple = { source: srcSem, target: tgtSem, kind: e.kind }
    baseEdgeKeys.set(edgeKey(et), et)
  }
  for (const e of target.edges) {
    const srcSem = targetCgToSem.get(e.source)
    const tgtSem = targetCgToSem.get(e.target)
    if (!srcSem || !tgtSem) continue
    const et: EdgeTuple = { source: srcSem, target: tgtSem, kind: e.kind }
    targetEdgeKeys.set(edgeKey(et), et)
  }

  for (const [k, et] of baseEdgeKeys) {
    if (!targetEdgeKeys.has(k)) ops.push({ op: 'remove_edge', edge: et })
  }
  for (const [k, et] of targetEdgeKeys) {
    if (!baseEdgeKeys.has(k)) ops.push({ op: 'add_edge', edge: et })
  }

  const operations = sortOps(ops)
  const baseHash = snapshotHash(base)
  const targetHash = snapshotHash(target)
  const partial = { version: 2 as const, base: baseHash, target: targetHash, operations }
  return { ...partial, diffHash: computeDiffHash(partial) }
}
