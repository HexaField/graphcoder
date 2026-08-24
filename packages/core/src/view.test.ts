/**
 * Unit tests for computeView — the server-side graph filtering and grouping function.
 *
 * Each test verifies a discrete phase of the pipeline:
 *   Phase 1 — node kind filtering
 *   Phase 2 — import elevation
 *   Phase 3 — grouping coercion (file/class nodes removed from layout nodes)
 *   Phase 4 — focus neighbourhood
 *   Phase 5 — edge filtering (kind, dedup, self-loops)
 *   Phase 6 — flat result (no grouping)
 *   Phase 7 — group building (file, class, contract, package)
 *   Phase 8 — collapsed child exclusion
 *   Phase 9 — edge promotion through collapsed group boundaries
 */

import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from './index.js'
import { computeView, DEFAULT_VIEW_PARAMS } from './view.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function node(
  id: string,
  kind: GraphNode['kind'],
  opts: Partial<Pick<GraphNode, 'name' | 'filePath' | 'qualifiedName'>> = {}
): GraphNode {
  return {
    id,
    kind,
    name: opts.name ?? id,
    qualifiedName: opts.qualifiedName ?? id,
    filePath: opts.filePath ?? `src/${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0
  }
}

function edge(source: string, target: string, kind: GraphEdge['kind'] = 'calls'): GraphEdge {
  return { source, target, kind }
}

function contains(parent: string, child: string): GraphEdge {
  return { source: parent, target: child, kind: 'contains' }
}

const FLAT_PARAMS = { ...DEFAULT_VIEW_PARAMS, groupByFile: false }

// ── Phase 1: node kind filtering ──────────────────────────────────────────────

describe('Phase 1 — node kind filtering', () => {
  it('returns all nodes when hiddenNodeKinds is empty', () => {
    const nodes = [node('a', 'function'), node('b', 'class')]
    const { nodes: out } = computeView(nodes, [], FLAT_PARAMS)
    expect(out.map((n) => n.id)).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('excludes nodes whose kind is in hiddenNodeKinds', () => {
    const nodes = [node('a', 'function'), node('b', 'class'), node('c', 'variable')]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      hiddenNodeKinds: ['class']
    })
    expect(out.map((n) => n.id)).toContain('a')
    expect(out.map((n) => n.id)).not.toContain('b')
    expect(out.map((n) => n.id)).toContain('c')
  })

  it('excludes multiple kinds simultaneously', () => {
    const nodes = [node('fn', 'function'), node('cls', 'class'), node('mod', 'module')]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      hiddenNodeKinds: ['class', 'module']
    })
    expect(out.map((n) => n.id)).toEqual(['fn'])
  })
})

// ── Phase 1b: path filtering ──────────────────────────────────────────────────

describe('Phase 1b — hiddenPaths filtering', () => {
  it('hides nodes whose filePath starts with a hidden path prefix', () => {
    const nodes = [
      node('a', 'function', { filePath: 'src/utils/helper.ts' }),
      node('b', 'function', { filePath: 'src/core/index.ts' })
    ]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      hiddenPaths: ['src/utils']
    })
    expect(out.map((n) => n.id)).not.toContain('a')
    expect(out.map((n) => n.id)).toContain('b')
  })

  it('hides nodes by exact filePath', () => {
    const nodes = [node('a', 'function', { filePath: 'src/a.ts' }), node('b', 'function', { filePath: 'src/b.ts' })]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      hiddenPaths: ['src/a.ts']
    })
    expect(out.map((n) => n.id)).not.toContain('a')
    expect(out.map((n) => n.id)).toContain('b')
  })
})

// ── Phase 1c: excludePatterns filtering ───────────────────────────────────────

describe('Phase 1c — excludePatterns filtering', () => {
  it('excludes nodes matching a glob pattern', () => {
    const nodes = [
      node('a', 'function', { filePath: 'src/foo.test.ts' }),
      node('b', 'function', { filePath: 'src/foo.ts' })
    ]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      excludePatterns: '*.test.*'
    })
    expect(out.map((n) => n.id)).not.toContain('a')
    expect(out.map((n) => n.id)).toContain('b')
  })

  it('accepts comma-separated patterns', () => {
    const nodes = [
      node('a', 'function', { filePath: 'src/foo.test.ts' }),
      node('b', 'function', { filePath: 'src/foo.spec.ts' }),
      node('c', 'function', { filePath: 'src/foo.ts' })
    ]
    const { nodes: out } = computeView(nodes, [], {
      ...FLAT_PARAMS,
      excludePatterns: '*.test.*, *.spec.*'
    })
    expect(out.map((n) => n.id)).toEqual(['c'])
  })
})

// ── Phase 2: import elevation ──────────────────────────────────────────────────

describe('Phase 2 — import node elevation', () => {
  it('removes import nodes and creates synthetic imports edges', () => {
    // file_a --contains--> imp --imports--> file_b
    // Expected: import node removed, synthetic edge file_a → file_b
    const nodes = [
      node('file_a', 'file', { filePath: 'a.ts' }),
      node('imp', 'import'),
      node('file_b', 'file', { filePath: 'b.ts' })
    ]
    const edges = [contains('file_a', 'imp'), edge('imp', 'file_b', 'imports')]
    const { nodes: out, edges: outEdges } = computeView(nodes, edges, FLAT_PARAMS)

    expect(out.map((n) => n.id)).not.toContain('imp')
    const synthetic = outEdges.find((e) => e.source === 'file_a' && e.target === 'file_b')
    expect(synthetic).toBeDefined()
    expect(synthetic!.kind).toBe('imports')
  })

  it('does not create a synthetic edge when source or target is hidden', () => {
    const nodes = [node('file_a', 'file'), node('imp', 'import'), node('file_b', 'file')]
    const edges = [contains('file_a', 'imp'), edge('imp', 'file_b', 'imports')]
    const { edges: outEdges } = computeView(nodes, edges, {
      ...FLAT_PARAMS,
      hiddenNodeKinds: ['file']
    })
    expect(outEdges.length).toBe(0)
  })
})

// ── Phase 4: focus neighbourhood ──────────────────────────────────────────────

describe('Phase 4 — focus neighbourhood', () => {
  it('retains only the focused node and its direct neighbours', () => {
    const nodes = [node('a', 'function'), node('b', 'function'), node('c', 'function')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    const { nodes: out, edges: outEdges } = computeView(nodes, edges, {
      ...FLAT_PARAMS,
      focusedNodeId: 'b'
    })
    const ids = out.map((n) => n.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(outEdges.length).toBe(2)
  })

  it('excludes nodes not connected to the focused node', () => {
    const nodes = [node('a', 'function'), node('b', 'function'), node('x', 'function')]
    const edges = [edge('a', 'b')]
    const { nodes: out } = computeView(nodes, edges, {
      ...FLAT_PARAMS,
      focusedNodeId: 'a'
    })
    const ids = out.map((n) => n.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('x')
  })

  it('no-ops when focusedNodeId is null', () => {
    const nodes = [node('a', 'function'), node('b', 'function')]
    const { nodes: out } = computeView(nodes, [], { ...FLAT_PARAMS, focusedNodeId: null })
    expect(out).toHaveLength(2)
  })
})

// ── Phase 5: edge filtering ───────────────────────────────────────────────────

describe('Phase 5 — edge filtering', () => {
  it('excludes edges whose kind is hidden', () => {
    const nodes = [node('a', 'function'), node('b', 'function')]
    const edges = [edge('a', 'b', 'calls'), edge('a', 'b', 'imports')]
    const { edges: out } = computeView(nodes, edges, {
      ...FLAT_PARAMS,
      hiddenEdgeKinds: ['imports']
    })
    expect(out.every((e) => e.kind !== 'imports')).toBe(true)
    expect(out.some((e) => e.kind === 'calls')).toBe(true)
  })

  it('deduplicates edges with same source, target, kind', () => {
    const nodes = [node('a', 'function'), node('b', 'function')]
    const edges = [edge('a', 'b'), edge('a', 'b'), edge('a', 'b')]
    const { edges: out } = computeView(nodes, edges, FLAT_PARAMS)
    expect(out).toHaveLength(1)
  })

  it('excludes self-loop edges', () => {
    const nodes = [node('a', 'function')]
    const edges = [edge('a', 'a')]
    const { edges: out } = computeView(nodes, edges, FLAT_PARAMS)
    expect(out).toHaveLength(0)
  })

  it('excludes edges where source or target is filtered out', () => {
    const nodes = [node('a', 'function'), node('b', 'class')]
    const edges = [edge('a', 'b')]
    const { edges: out } = computeView(nodes, edges, {
      ...FLAT_PARAMS,
      hiddenNodeKinds: ['class']
    })
    expect(out).toHaveLength(0)
  })
})

// ── Phase 6: flat result ──────────────────────────────────────────────────────

describe('Phase 6 — flat result (no grouping)', () => {
  it('returns empty groups when no grouping is active', () => {
    const nodes = [node('a', 'function'), node('b', 'function')]
    const { groups } = computeView(nodes, [], FLAT_PARAMS)
    expect(groups).toHaveLength(0)
  })

  it('includes file nodes in fileNodes regardless of kind filter', () => {
    const nodes = [node('f', 'file', { filePath: 'src/f.ts' }), node('fn', 'function', { filePath: 'src/f.ts' })]
    const { fileNodes } = computeView(nodes, [], FLAT_PARAMS)
    expect(fileNodes.map((n) => n.id)).toContain('f')
  })

  it('fileNodes excludes non-file/module nodes', () => {
    const nodes = [
      node('fn', 'function'),
      node('f', 'file', { filePath: 'a.ts' }),
      node('m', 'module', { filePath: 'b.ts' })
    ]
    const { fileNodes } = computeView(nodes, [], FLAT_PARAMS)
    expect(fileNodes.map((n) => n.id)).not.toContain('fn')
    expect(fileNodes.map((n) => n.id)).toContain('f')
    expect(fileNodes.map((n) => n.id)).toContain('m')
  })
})

// ── Phase 7: group building ───────────────────────────────────────────────────

describe('Phase 7 — file group building', () => {
  it('builds a file group for each file node', () => {
    const nodes = [
      node('f1', 'file', { filePath: 'src/a.ts' }),
      node('fn1', 'function', { filePath: 'src/a.ts' }),
      node('fn2', 'function', { filePath: 'src/a.ts' })
    ]
    const edges = [contains('f1', 'fn1'), contains('f1', 'fn2')]
    const { groups } = computeView(nodes, edges, {
      ...DEFAULT_VIEW_PARAMS,
      groupByFile: true,
      expandedGroups: ['src/a.ts'] // expanded
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('f1')
    expect(groups[0].childIds).toEqual(expect.arrayContaining(['fn1', 'fn2']))
  })

  it('excludes file nodes from layout nodes when groupByFile is true', () => {
    const nodes = [node('f1', 'file', { filePath: 'src/a.ts' }), node('fn1', 'function', { filePath: 'src/a.ts' })]
    const edges = [contains('f1', 'fn1')]
    const { nodes: out } = computeView(nodes, edges, {
      ...DEFAULT_VIEW_PARAMS,
      groupByFile: true,
      expandedGroups: ['src/a.ts']
    })
    expect(out.map((n) => n.id)).not.toContain('f1')
    expect(out.map((n) => n.id)).toContain('fn1')
  })

  it('skips file groups with no visible children', () => {
    const nodes = [node('f1', 'file', { filePath: 'src/a.ts' }), node('fn1', 'function', { filePath: 'src/a.ts' })]
    const edges = [contains('f1', 'fn1')]
    // Hide the function node — file group has no visible children
    const { groups } = computeView(nodes, edges, {
      ...DEFAULT_VIEW_PARAMS,
      groupByFile: true,
      hiddenNodeKinds: ['function'],
      expandedGroups: ['src/a.ts']
    })
    expect(groups).toHaveLength(0)
  })
})

// ── Phase 8 + 9: collapse + edge promotion ────────────────────────────────────

describe('Phase 8+9 — collapsed groups and edge promotion', () => {
  // Setup: two files, each with one function. An edge fn1 → fn2.
  // Both files are collapsed (expandedGroups is empty).

  const allNodes = [
    node('f1', 'file', { filePath: 'src/a.ts' }),
    node('fn1', 'function', { filePath: 'src/a.ts' }),
    node('f2', 'file', { filePath: 'src/b.ts' }),
    node('fn2', 'function', { filePath: 'src/b.ts' })
  ]
  const allEdges = [contains('f1', 'fn1'), contains('f2', 'fn2'), edge('fn1', 'fn2')]

  const collapsedParams = {
    ...DEFAULT_VIEW_PARAMS,
    groupByFile: true,
    expandedGroups: [] // all collapsed
  }

  it('excludes collapsed child nodes from layout nodes', () => {
    const { nodes: out } = computeView(allNodes, allEdges, collapsedParams)
    expect(out.map((n) => n.id)).not.toContain('fn1')
    expect(out.map((n) => n.id)).not.toContain('fn2')
  })

  it('marks collapsed groups with collapsed=true and empty childIds', () => {
    const { groups } = computeView(allNodes, allEdges, collapsedParams)
    for (const g of groups) {
      expect(g.collapsed).toBe(true)
      expect(g.childIds).toHaveLength(0)
    }
  })

  it('promotes edge endpoints from collapsed children to their group containers', () => {
    const { edges: out } = computeView(allNodes, allEdges, collapsedParams)
    // fn1 → fn2 promoted to f1 → f2
    const promoted = out.find((e) => e.source === 'f1' && e.target === 'f2')
    expect(promoted).toBeDefined()
    // Original fn1 → fn2 edge must NOT appear (collapsed child is excluded)
    const original = out.find((e) => e.source === 'fn1' && e.target === 'fn2')
    expect(original).toBeUndefined()
  })

  it('drops promoted edges where source and target collapse to the same group', () => {
    // Both fn1 and fn2 are in the same file — collapse both into same group
    const singleFile = [
      node('f1', 'file', { filePath: 'src/a.ts' }),
      node('fn1', 'function', { filePath: 'src/a.ts' }),
      node('fn2', 'function', { filePath: 'src/a.ts' })
    ]
    const singleEdges = [contains('f1', 'fn1'), contains('f1', 'fn2'), edge('fn1', 'fn2')]
    const { edges: out } = computeView(singleFile, singleEdges, collapsedParams)
    // f1 → f1 self-loop must be dropped
    const selfLoop = out.find((e) => e.source === 'f1' && e.target === 'f1')
    expect(selfLoop).toBeUndefined()
  })

  it('deduplicates promoted edges', () => {
    // Both fn1→fn2 and fn1→fn2 (duplicate) should become a single f1→f2
    const dupEdges = [
      contains('f1', 'fn1'),
      contains('f2', 'fn2'),
      edge('fn1', 'fn2'),
      edge('fn1', 'fn2') // duplicate
    ]
    const { edges: out } = computeView(allNodes, dupEdges, collapsedParams)
    const promoted = out.filter((e) => e.source === 'f1' && e.target === 'f2')
    expect(promoted).toHaveLength(1)
  })

  it('preserves edges between un-collapsed nodes', () => {
    // fn1 expanded, fn2 collapsed
    const mixedParams = { ...collapsedParams, expandedGroups: ['src/a.ts'] }
    const { edges: out } = computeView(allNodes, allEdges, mixedParams)
    // fn1 is visible (expanded group), fn2 is not (collapsed) → fn1 → f2
    const e = out.find((e) => e.source === 'fn1' && e.target === 'f2')
    expect(e).toBeDefined()
  })
})

// ── DEFAULT_VIEW_PARAMS ───────────────────────────────────────────────────────

describe('DEFAULT_VIEW_PARAMS', () => {
  it('has groupByFile: true', () => {
    expect(DEFAULT_VIEW_PARAMS.groupByFile).toBe(true)
  })

  it('has empty expandedGroups (all groups collapsed)', () => {
    expect(DEFAULT_VIEW_PARAMS.expandedGroups).toHaveLength(0)
  })

  it('produces valid output on an empty graph', () => {
    const result = computeView([], [], DEFAULT_VIEW_PARAMS)
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.groups).toHaveLength(0)
    expect(result.fileNodes).toHaveLength(0)
  })
})

// ── Edge direction correctness ────────────────────────────────────────────────

describe('Edge direction — promoted edges preserve direction', () => {
  it('source and target are not swapped when promoting', () => {
    const nodes = [
      node('f1', 'file', { filePath: 'src/a.ts' }),
      node('fn1', 'function', { filePath: 'src/a.ts' }),
      node('f2', 'file', { filePath: 'src/b.ts' }),
      node('fn2', 'function', { filePath: 'src/b.ts' })
    ]
    // Directed: fn2 CALLS fn1 (reversed from previous tests)
    const edges = [contains('f1', 'fn1'), contains('f2', 'fn2'), edge('fn2', 'fn1')]
    const { edges: out } = computeView(nodes, edges, {
      ...DEFAULT_VIEW_PARAMS,
      groupByFile: true,
      expandedGroups: []
    })
    // Should be f2 → f1, NOT f1 → f2
    const e = out.find((e) => e.source === 'f2' && e.target === 'f1')
    expect(e).toBeDefined()
    const reversed = out.find((e) => e.source === 'f1' && e.target === 'f2')
    expect(reversed).toBeUndefined()
  })
})

// ── Phase 7b: class grouping ──────────────────────────────────────────────────

describe('Phase 7b — class sub-group building', () => {
  it('nests methods under their class within a file group', () => {
    const nodes = [
      node('f1', 'file', { filePath: 'src/a.ts' }),
      node('cls', 'class', { filePath: 'src/a.ts' }),
      node('method', 'function', { filePath: 'src/a.ts' })
    ]
    const edges = [contains('f1', 'cls'), contains('cls', 'method')]
    const { groups } = computeView(nodes, edges, {
      ...DEFAULT_VIEW_PARAMS,
      groupByFile: true,
      groupByClass: true,
      expandedGroups: ['src/a.ts']
    })
    expect(groups).toHaveLength(1)
    const fileGroup = groups[0]
    expect(fileGroup.childGroups).toBeDefined()
    expect(fileGroup.childGroups!.length).toBeGreaterThan(0)
    const classGroup = fileGroup.childGroups![0]
    expect(classGroup.childIds).toContain('method')
  })
})

// ── globToRegex ───────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  it('is exported from view.ts', async () => {
    const { globToRegex } = await import('./view.js')
    const re = globToRegex('*.test.*')
    expect(re).not.toBeNull()
    expect(re!.test('foo.test.ts')).toBe(true)
    expect(re!.test('foo.ts')).toBe(false)
  })

  it('returns null for empty patterns', async () => {
    const { globToRegex } = await import('./view.js')
    expect(globToRegex('')).toBeNull()
    expect(globToRegex('   ')).toBeNull()
  })
})
