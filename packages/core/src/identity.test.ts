import { describe, expect, it } from 'vitest'
import { buildDiffIdMap, normalizeSignature, nodeSemanticId, semanticId } from './identity.js'
import type { GraphNode } from './index.js'

function makeNode(
  id: string,
  name: string,
  kind: GraphNode['kind'] = 'function',
  filePath = 'src/a.ts',
  signature?: string
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    signature
  }
}

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
  it('matches semanticId(kind, name, signature) for symbol nodes', () => {
    const node = {
      kind: 'function' as const,
      name: 'add',
      filePath: 'src/math.ts',
      signature: '(a: number, b: number): number'
    }
    expect(nodeSemanticId(node)).toBe(semanticId(node.kind, node.name, node.signature))
  })

  it('uses filePath instead of name for file nodes', () => {
    const fileA = { kind: 'file' as const, name: 'index.ts', filePath: 'packages/client/src/index.ts' }
    const fileB = { kind: 'file' as const, name: 'index.ts', filePath: 'packages/server/src/index.ts' }
    // Same name, different path → different semantic IDs
    expect(nodeSemanticId(fileA)).not.toBe(nodeSemanticId(fileB))
    // Path-based: matches semanticId with filePath as the name component
    expect(nodeSemanticId(fileA)).toBe(semanticId('file', fileA.filePath))
  })

  it('uses filePath instead of name for module nodes', () => {
    const modA = { kind: 'module' as const, name: 'utils', filePath: 'packages/core/src/utils.ts' }
    const modB = { kind: 'module' as const, name: 'utils', filePath: 'packages/server/src/utils.ts' }
    expect(nodeSemanticId(modA)).not.toBe(nodeSemanticId(modB))
  })
})

describe('buildDiffIdMap', () => {
  it('returns empty map for empty inputs', () => {
    const map = buildDiffIdMap([], [])
    expect(map.size).toBe(0)
  })

  it('maps semantic IDs to CodeGraph IDs for target-only nodes', () => {
    const target = [makeNode('cg:func-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    const map = buildDiffIdMap([], target)
    const semId = nodeSemanticId(target[0])
    expect(map.get(semId)).toBe('cg:func-1')
  })

  it('maps semantic IDs to CodeGraph IDs for base-only nodes (removed)', () => {
    const base = [makeNode('cg:old-1', 'remove', 'function', 'src/math.ts')]
    const map = buildDiffIdMap(base, [])
    const semId = nodeSemanticId(base[0])
    expect(map.get(semId)).toBe('cg:old-1')
  })

  it('target CodeGraph ID overwrites base for the same semantic identity', () => {
    // Same function in both snapshots, different CodeGraph IDs
    const base = [makeNode('cg:base-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    const target = [makeNode('cg:target-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    const map = buildDiffIdMap(base, target)
    const semId = nodeSemanticId(base[0])
    // Target wins
    expect(map.get(semId)).toBe('cg:target-1')
  })

  it('preserves base ID when target has no matching node', () => {
    const base = [
      makeNode('cg:base-1', 'add', 'function', 'src/math.ts'),
      makeNode('cg:base-2', 'remove', 'function', 'src/math.ts')
    ]
    const target = [makeNode('cg:target-1', 'add', 'function', 'src/new.ts')]
    const map = buildDiffIdMap(base, target)

    // 'add' appears in both — target wins
    const addSem = nodeSemanticId(base[0])
    expect(map.get(addSem)).toBe('cg:target-1')

    // 'remove' only in base — base ID retained
    const removeSem = nodeSemanticId(base[1])
    expect(map.get(removeSem)).toBe('cg:base-2')
  })

  it('semantic ID ignores filePath (moved functions share identity)', () => {
    const base = [makeNode('cg:old', 'add', 'function', 'src/old.ts', '(a, b)')]
    const target = [makeNode('cg:new', 'add', 'function', 'src/new.ts', '(a, b)')]
    const map = buildDiffIdMap(base, target)
    // Same semantic identity despite different files
    expect(map.size).toBe(1)
    const semId = nodeSemanticId(base[0])
    expect(map.get(semId)).toBe('cg:new') // target wins
  })

  it('different signatures produce distinct entries', () => {
    const base = [makeNode('cg:v1', 'add', 'function', 'src/a.ts', '(a: number)')]
    const target = [makeNode('cg:v2', 'add', 'function', 'src/a.ts', '(a: number, b: number)')]
    const map = buildDiffIdMap(base, target)
    expect(map.size).toBe(2) // different semantic IDs
  })

  it('handles multiple nodes across both snapshots', () => {
    const base = [
      makeNode('cg:b1', 'foo', 'function', 'src/a.ts'),
      makeNode('cg:b2', 'bar', 'function', 'src/a.ts'),
      makeNode('cg:b3', 'baz', 'function', 'src/b.ts')
    ]
    const target = [makeNode('cg:t1', 'foo', 'function', 'src/a.ts'), makeNode('cg:t4', 'qux', 'function', 'src/c.ts')]
    const map = buildDiffIdMap(base, target)

    // foo: in both, target wins
    expect(map.get(nodeSemanticId(base[0]))).toBe('cg:t1')
    // bar: base only
    expect(map.get(nodeSemanticId(base[1]))).toBe('cg:b2')
    // baz: base only
    expect(map.get(nodeSemanticId(base[2]))).toBe('cg:b3')
    // qux: target only
    expect(map.get(nodeSemanticId(target[1]))).toBe('cg:t4')
    expect(map.size).toBe(4)
  })

  it('round-trips: semantic ID from a remapped node resolves to original CG ID', () => {
    // Simulate the full flow: buildDiffIdMap → remap node IDs → resolve back
    const base = [makeNode('cg:base-fn', 'processData', 'function', 'src/proc.ts', '(input: Buffer)')]
    const target = [makeNode('cg:target-fn', 'processData', 'function', 'src/proc.ts', '(input: Buffer)')]

    const map = buildDiffIdMap(base, target)
    const semId = nodeSemanticId(target[0])

    // After remapping, the node's id becomes semId
    const remappedNode = { ...target[0], id: semId }

    // To call the REST API, resolve back through the map
    const resolvedCgId = map.get(remappedNode.id)
    expect(resolvedCgId).toBe('cg:target-fn')
  })
})
