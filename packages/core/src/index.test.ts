import { describe, expect, it } from 'vitest'
import type { GraphNode, NodeKind } from './index.js'

describe('Core types', () => {
  it('NodeKind values are valid string literals', () => {
    const kind: NodeKind = 'function'
    expect(kind).toBe('function')
  })

  it('GraphNode type has required fields', () => {
    const node: GraphNode = {
      id: 'test-id',
      kind: 'function',
      name: 'testFn',
      qualifiedName: 'module.testFn',
      filePath: 'src/test.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0
    }
    expect(node.id).toBe('test-id')
    expect(node.kind).toBe('function')
  })
})
