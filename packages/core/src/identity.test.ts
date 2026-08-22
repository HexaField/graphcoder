import { describe, expect, it } from 'vitest'
import { normalizeSignature, nodeSemanticId, semanticId } from './identity.js'

describe('normalizeSignature', () => {
  it('collapses whitespace', () => {
    expect(normalizeSignature('a:  string')).toBe('a: string')
  })
  it('strips simple defaults', () => {
    expect(normalizeSignature('(a: string, b: number = 0)')).toBe('(a: string, b: number)')
  })
})

describe('semanticId', () => {
  it('produces a 64-char hex string', () => {
    const id = semanticId('function', 'foo', '(a: string): void')
    expect(id).toHaveLength(64)
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  it('is stable for identical inputs', () => {
    const a = semanticId('function', 'foo', '(a: string): void')
    const b = semanticId('function', 'foo', '(a: string): void')
    expect(a).toBe(b)
  })

  it('differs when name changes', () => {
    expect(semanticId('function', 'foo')).not.toBe(semanticId('function', 'bar'))
  })

  it('differs when kind changes', () => {
    expect(semanticId('function', 'foo')).not.toBe(semanticId('method', 'foo'))
  })

  it('is stable across file moves (no file path in identity)', () => {
    const id = semanticId('function', 'add', '(a: number, b: number): number')
    expect(semanticId('function', 'add', '(a: number, b: number): number')).toBe(id)
  })
})

describe('nodeSemanticId', () => {
  it('matches semanticId(kind, name, signature)', () => {
    const node = {
      kind: 'function' as const,
      name: 'add',
      signature: '(a: number, b: number): number'
    }
    expect(nodeSemanticId(node)).toBe(semanticId(node.kind, node.name, node.signature))
  })
})
