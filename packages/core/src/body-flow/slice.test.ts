import { describe, expect, it } from 'vitest'
import type { TracedFlow } from '../flow/types.js'
import type { BodyFlow, CFEdge, CFNode } from './types.js'
import { flowSuccessors, sliceBodyFlow } from './slice.js'

function cf(id: string, kind: CFNode['kind'], extra: Partial<CFNode> = {}): CFNode {
  return { id, kind, label: id, line: 1, column: 0, ...extra }
}

function e(source: string, target: string, kind: CFEdge['kind'] = 'next'): CFEdge {
  return { source, target, kind }
}

function flow(nodes: CFNode[], edges: CFEdge[]): BodyFlow {
  return { functionNodeId: 'fn', signature: 'function fn()', nodes, edges }
}

// entry → validate → if ─true→ login → save → exit
//                      └false→ sendError ────────┘
const branching = flow(
  [
    cf('entry', 'entry'),
    cf('validate', 'call', { targetNodeId: 'g:validate' }),
    cf('if', 'branch'),
    cf('login', 'call', { targetNodeId: 'g:login' }),
    cf('save', 'call', { targetNodeId: 'g:save' }),
    cf('sendError', 'call', { targetNodeId: 'g:sendError' }),
    cf('exit', 'exit')
  ],
  [
    e('entry', 'validate'),
    e('validate', 'if'),
    e('if', 'login', 'true'),
    e('login', 'save'),
    e('save', 'exit'),
    e('if', 'sendError', 'false'),
    e('sendError', 'exit')
  ]
)

describe('sliceBodyFlow', () => {
  it('keeps only the path from entry to the target call', () => {
    const slice = sliceBodyFlow(branching, new Set(['g:login']))!
    expect([...slice.nodeIds].sort()).toEqual(['entry', 'if', 'login', 'validate'])
    expect([...slice.hitNodeIds]).toEqual(['login'])
    const onPath = [...slice.edgeIndices].map((i) => branching.edges[i]!)
    expect(onPath).toEqual([e('entry', 'validate'), e('validate', 'if'), e('if', 'login', 'true')])
  })

  it('takes the other branch when the target sits there', () => {
    const slice = sliceBodyFlow(branching, new Set(['g:sendError']))!
    expect(slice.nodeIds.has('sendError')).toBe(true)
    expect(slice.nodeIds.has('login')).toBe(false)
  })

  it('unions the paths to several targets', () => {
    const slice = sliceBodyFlow(branching, new Set(['g:save', 'g:sendError']))!
    expect([...slice.nodeIds].sort()).toEqual(['entry', 'if', 'login', 'save', 'sendError', 'validate'])
    expect(slice.nodeIds.has('exit')).toBe(false)
  })

  it('keeps a loop body when the target follows the loop', () => {
    const looped = flow(
      [
        cf('entry', 'entry'),
        cf('loop', 'loop'),
        cf('step', 'call'),
        cf('done', 'call', { targetNodeId: 't' }),
        cf('exit', 'exit')
      ],
      [
        e('entry', 'loop'),
        e('loop', 'step', 'loop_body'),
        e('step', 'loop', 'loop_back'),
        e('loop', 'done', 'loop_exit'),
        e('done', 'exit')
      ]
    )
    const slice = sliceBodyFlow(looped, new Set(['t']))!
    expect([...slice.nodeIds].sort()).toEqual(['done', 'entry', 'loop', 'step'])
    expect(slice.edgeIndices.size).toBe(4)
  })

  it('matches a target inside a merged block node', () => {
    const blocked = flow(
      [
        cf('entry', 'entry'),
        cf('block', 'block', {
          calls: [
            { label: 'a', line: 2 },
            { label: 'b', line: 3, targetNodeId: 't' }
          ]
        }),
        cf('exit', 'exit')
      ],
      [e('entry', 'block'), e('block', 'exit')]
    )
    expect([...sliceBodyFlow(blocked, new Set(['t']))!.hitNodeIds]).toEqual(['block'])
  })

  it('returns null when no call invokes a target', () => {
    expect(sliceBodyFlow(branching, new Set(['g:elsewhere']))).toBeNull()
    expect(sliceBodyFlow(branching, new Set())).toBeNull()
  })

  it('returns null when the only matching call is unreachable', () => {
    const orphan = flow(
      [cf('entry', 'entry'), cf('dead', 'call', { targetNodeId: 't' }), cf('exit', 'exit')],
      [e('entry', 'exit')]
    )
    expect(sliceBodyFlow(orphan, new Set(['t']))).toBeNull()
  })
})

describe('flowSuccessors', () => {
  it('collects direct callees of a function across all traced flows', () => {
    const flows: TracedFlow[] = [
      {
        entryNodeId: 'a',
        nodes: [],
        edges: [
          { source: 'a', target: 'b', kind: 'calls' },
          { source: 'b', target: 'c', kind: 'calls' }
        ],
        branches: []
      },
      { entryNodeId: 'x', nodes: [], edges: [{ source: 'b', target: 'd', kind: 'calls' }], branches: [] }
    ]
    expect([...flowSuccessors(flows, 'b')].sort()).toEqual(['c', 'd'])
    expect(flowSuccessors(flows, 'c').size).toBe(0)
  })
})
