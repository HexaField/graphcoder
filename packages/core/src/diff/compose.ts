import { computeDiffHash } from './hash.js'
import type { ArchDiff, ArchOp, NodeProps } from './types.js'
import { sortOps } from './compute.js'

function opKey(op: ArchOp): string {
  switch (op.op) {
    case 'add_node':
      return `node:${op.node.id}`
    case 'remove_node':
    case 'modify_node':
    case 'move_node':
      return `node:${op.id}`
    case 'add_edge':
    case 'remove_edge':
      return `edge:${op.edge.source}|${op.edge.target}|${op.edge.kind}`
  }
}

export function compose(abDiff: ArchDiff, bcDiff: ArchDiff): ArchDiff {
  if (abDiff.target !== bcDiff.base) {
    throw new Error(`Cannot compose: diff_AB.target (${abDiff.target}) !== diff_BC.base (${bcDiff.base})`)
  }

  const opsByKey = new Map<string, ArchOp>()
  for (const op of abDiff.operations) {
    opsByKey.set(opKey(op), op)
  }

  for (const bcOp of bcDiff.operations) {
    const key = opKey(bcOp)
    const abOp = opsByKey.get(key)

    if (!abOp) {
      opsByKey.set(key, bcOp)
      continue
    }

    if (abOp.op === 'add_node' && bcOp.op === 'remove_node' && abOp.node.id === bcOp.id) {
      opsByKey.delete(key)
    } else if (abOp.op === 'add_node' && bcOp.op === 'modify_node' && abOp.node.id === bcOp.id) {
      opsByKey.set(key, { op: 'add_node', node: { ...abOp.node, ...bcOp.next } })
    } else if (abOp.op === 'add_node' && bcOp.op === 'move_node' && abOp.node.id === bcOp.id) {
      opsByKey.set(key, { op: 'add_node', node: { ...abOp.node, filePath: bcOp.to.filePath } })
    } else if (abOp.op === 'modify_node' && bcOp.op === 'modify_node') {
      const mergedPrev = { ...abOp.prev }
      const mergedNext = { ...abOp.next, ...bcOp.next }
      for (const f of Object.keys(bcOp.prev) as (keyof NodeProps)[]) {
        if (!(f in abOp.prev)) {
          ;(mergedPrev as Record<string, unknown>)[f] = bcOp.prev[f]
        }
      }
      opsByKey.set(key, { op: 'modify_node', id: abOp.id, prev: mergedPrev, next: mergedNext })
    } else if (abOp.op === 'move_node' && bcOp.op === 'move_node') {
      opsByKey.set(key, { op: 'move_node', id: abOp.id, from: abOp.from, to: bcOp.to })
    } else if (abOp.op === 'add_edge' && bcOp.op === 'remove_edge') {
      opsByKey.delete(key)
    } else {
      opsByKey.set(key, bcOp)
    }
  }

  const operations = sortOps([...opsByKey.values()])
  const partial = { version: 2 as const, base: abDiff.base, target: bcDiff.target, operations }
  return { ...partial, diffHash: computeDiffHash(partial) }
}
