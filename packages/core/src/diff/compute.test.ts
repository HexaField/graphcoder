import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../index.js'
import { makeEdge, makeNode } from './fixtures.js'
import { computeArchDiff } from './compute.js'

describe('computeArchDiff', () => {
  it('returns empty diff for identical snapshots', () => {
    const snap: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const diff = computeArchDiff(snap, snap)
    expect(diff.operations).toHaveLength(0)
    expect(diff.base).toBe(diff.target)
  })

  it('detects an added node', () => {
    const base: GraphSnapshot = { nodes: [], edges: [] }
    const target: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const diff = computeArchDiff(base, target)
    expect(diff.operations).toHaveLength(1)
    expect(diff.operations[0].op).toBe('add_node')
    if (diff.operations[0].op === 'add_node') {
      expect(diff.operations[0].node.name).toBe('foo')
    }
  })

  it('detects a removed node', () => {
    const base: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const target: GraphSnapshot = { nodes: [], edges: [] }
    const diff = computeArchDiff(base, target)
    expect(diff.operations).toHaveLength(1)
    expect(diff.operations[0].op).toBe('remove_node')
  })

  it('detects a move (same semantic ID, different filePath)', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'add', 'function', 'src/math.ts')],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n2', 'add', 'function', 'src/arithmetic.ts')],
      edges: []
    }
    const diff = computeArchDiff(base, target)
    const moveOps = diff.operations.filter((o) => o.op === 'move_node')
    expect(moveOps).toHaveLength(1)
    if (moveOps[0].op === 'move_node') {
      expect(moveOps[0].from.filePath).toBe('src/math.ts')
      expect(moveOps[0].to.filePath).toBe('src/arithmetic.ts')
    }
  })

  it('detects a modification (visibility changed)', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'function', 'src/a.ts', { visibility: 'private' })],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'function', 'src/a.ts', { visibility: 'public' })],
      edges: []
    }
    const diff = computeArchDiff(base, target)
    const modOps = diff.operations.filter((o) => o.op === 'modify_node')
    expect(modOps).toHaveLength(1)
    if (modOps[0].op === 'modify_node') {
      expect(modOps[0].prev.visibility).toBe('private')
      expect(modOps[0].next.visibility).toBe('public')
    }
  })

  it('annotates probable renames with renameOf hint', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'subtract', 'function', 'src/math.ts', { startLine: 3, endLine: 5 })],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n2', 'minus', 'function', 'src/math.ts', { startLine: 3, endLine: 5 })],
      edges: []
    }
    const diff = computeArchDiff(base, target)
    const addOp = diff.operations.find((o) => o.op === 'add_node')
    expect(addOp?.op).toBe('add_node')
    if (addOp?.op === 'add_node') {
      expect(addOp.node.properties?.renameOf).toBeTruthy()
    }
  })

  it('detects an added edge', () => {
    const n1 = makeNode('n1', 'foo')
    const n2 = makeNode('n2', 'bar')
    const base: GraphSnapshot = { nodes: [n1, n2], edges: [] }
    const target: GraphSnapshot = { nodes: [n1, n2], edges: [makeEdge('n1', 'n2')] }
    const diff = computeArchDiff(base, target)
    const addEdge = diff.operations.filter((o) => o.op === 'add_edge')
    expect(addEdge).toHaveLength(1)
  })

  it('detects a removed edge', () => {
    const n1 = makeNode('n1', 'foo')
    const n2 = makeNode('n2', 'bar')
    const base: GraphSnapshot = { nodes: [n1, n2], edges: [makeEdge('n1', 'n2')] }
    const target: GraphSnapshot = { nodes: [n1, n2], edges: [] }
    const diff = computeArchDiff(base, target)
    expect(diff.operations.filter((o) => o.op === 'remove_edge')).toHaveLength(1)
  })

  it('produces canonical ordering (removes before adds)', () => {
    const base: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const target: GraphSnapshot = { nodes: [makeNode('n2', 'bar')], edges: [] }
    const diff = computeArchDiff(base, target)
    expect(diff.operations[0].op).toBe('remove_node')
    expect(diff.operations[diff.operations.length - 1].op).toBe('add_node')
  })

  it('diffHash is deterministic', () => {
    const snap1: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const snap2: GraphSnapshot = { nodes: [], edges: [] }
    expect(computeArchDiff(snap1, snap2).diffHash).toBe(computeArchDiff(snap1, snap2).diffHash)
  })
})
