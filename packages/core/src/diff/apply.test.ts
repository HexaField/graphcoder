import { describe, expect, it } from 'vitest'
import type { GraphNode, GraphSnapshot } from '../index.js'
import { nodeSemanticId } from '../identity.js'
import { applyArchDiff } from './apply.js'
import { computeArchDiff } from './compute.js'

function makeNode(id: string, name: string, filePath = 'src/a.ts', extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...extra
  }
}

function semIds(snap: GraphSnapshot): Set<string> {
  return new Set(snap.nodes.map(nodeSemanticId))
}

describe('applyArchDiff', () => {
  it('throws on base hash mismatch', () => {
    const base: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const target: GraphSnapshot = { nodes: [], edges: [] }
    const diff = computeArchDiff(base, target)
    const wrong: GraphSnapshot = { nodes: [makeNode('n2', 'bar')], edges: [] }
    expect(() => applyArchDiff(wrong, diff)).toThrow(/mismatch/)
  })

  it('round-trips: apply(computeArchDiff(A, B), A) has same semIds as B', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo'), makeNode('n2', 'bar')],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n3', 'bar'), makeNode('n4', 'baz')],
      edges: []
    }
    const result = applyArchDiff(base, computeArchDiff(base, target))
    expect(semIds(result)).toEqual(semIds(target))
  })

  it('applies a move correctly', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'add', 'src/math.ts')],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n2', 'add', 'src/arithmetic.ts')],
      edges: []
    }
    const result = applyArchDiff(base, computeArchDiff(base, target))
    expect(result.nodes[0].filePath).toBe('src/arithmetic.ts')
  })

  it('applies a modification correctly', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'src/a.ts', { visibility: 'private' })],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'src/a.ts', { visibility: 'public' })],
      edges: []
    }
    const result = applyArchDiff(base, computeArchDiff(base, target))
    expect(result.nodes[0].visibility).toBe('public')
  })
})
