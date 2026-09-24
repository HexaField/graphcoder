import type { CFNode, CFEdge, CFEdgeKind, CFNodeKind, BodyFlow } from '@graphcoder/core'
import type { Edge, Node } from '@colbymchenry/codegraph'
import type { SyntaxNode } from './parser.js'

let nextId = 0
function cfId(): string {
  return `bf:${nextId++}`
}

function resetIds(): void {
  nextId = 0
}

const BRANCH_TYPES = new Set(['if_statement', 'if_expression'])
const LOOP_TYPES = new Set([
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'for_expression',
  'while_expression'
])
const TRY_TYPES = new Set(['try_statement'])
const GUARD_TYPES = new Set(['return_statement', 'throw_statement'])
const CALL_TYPES = new Set(['call_expression', 'new_expression'])
const SWITCH_TYPES = new Set(['switch_statement'])
const BODY_TYPES = new Set(['statement_block', 'block'])
const THEN_CATCH_FINALLY = new Set(['then', 'catch', 'finally'])

function buildCallTargetIndex(outgoingEdges: Edge[]): Map<number, string> {
  const index = new Map<number, string>()
  for (const edge of outgoingEdges) {
    if (edge.kind !== 'calls' || edge.line == null) continue
    index.set(edge.line, edge.target)
  }
  return index
}

function extractConditionText(node: SyntaxNode): string {
  const cond = node.childForFieldName('condition')
  if (cond) return cond.text.slice(0, 80)
  const paren = node.namedChildren.find((c) => c.type === 'parenthesized_expression')
  if (paren) return paren.text.slice(0, 80)
  return ''
}

function extractCallName(node: SyntaxNode): string {
  const fn = node.childForFieldName('function')
  if (!fn) return node.text.split('(')[0]!.trim().slice(0, 60)
  if (fn.type === 'member_expression') {
    const objNode = fn.childForFieldName('object')
    const prop = fn.childForFieldName('property')
    if (objNode && prop) return `${objNode.text.slice(0, 30)}.${prop.text}`
  }
  return fn.text.slice(0, 60)
}

function isPromiseChainMethod(node: SyntaxNode): string | null {
  const fn = node.childForFieldName('function')
  if (!fn || fn.type !== 'member_expression') return null
  const prop = fn.childForFieldName('property')
  if (!prop) return null
  return THEN_CATCH_FINALLY.has(prop.text) ? prop.text : null
}

function unwindPromiseChain(node: SyntaxNode): SyntaxNode[] {
  const steps: SyntaxNode[] = []
  let current: SyntaxNode | null = node
  while (current && CALL_TYPES.has(current.type)) {
    const method = isPromiseChainMethod(current)
    if (!method) {
      steps.unshift(current)
      break
    }
    steps.unshift(current)
    const fn: SyntaxNode | null = current.childForFieldName('function')
    const objNode: SyntaxNode | null = fn?.childForFieldName('object') ?? null
    current = objNode
  }
  return steps
}

interface WalkContext {
  nodes: CFNode[]
  edges: CFEdge[]
  callTargets: Map<number, string>
  functionStartLine: number
  noiseNames: Set<string>
}

function addEdge(ctx: WalkContext, source: string, target: string, kind: CFEdgeKind, label?: string): void {
  if (!source || !target) return
  ctx.edges.push({ source, target, kind, ...(label ? { label } : {}) })
}

function addNode(ctx: WalkContext, kind: CFNodeKind, label: string, node: SyntaxNode, extra?: Partial<CFNode>): CFNode {
  const cfNode: CFNode = {
    id: cfId(),
    kind,
    label,
    line: ctx.functionStartLine + node.startPosition.row,
    column: node.startPosition.column,
    ...extra
  }
  ctx.nodes.push(cfNode)
  return cfNode
}

function resolveCallTarget(ctx: WalkContext, node: SyntaxNode): string | null {
  const absoluteLine = ctx.functionStartLine + node.startPosition.row + 1
  return ctx.callTargets.get(absoluteLine) ?? null
}

function isNoiseCall(ctx: WalkContext, name: string): boolean {
  const baseName = name.includes('.') ? name.split('.').pop()! : name
  return ctx.noiseNames.has(baseName)
}

function collectCalls(node: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = []
  function walk(n: SyntaxNode): void {
    if (CALL_TYPES.has(n.type)) {
      calls.push(n)
      return
    }
    for (const child of n.namedChildren) walk(child)
  }
  for (const child of node.namedChildren) walk(child)
  return calls
}

function bodyStatements(node: SyntaxNode): SyntaxNode[] {
  return BODY_TYPES.has(node.type) ? node.namedChildren : [node]
}

// ── Statement walkers ──────────────────────────────────────────────────────

const TERMINATED = '\x00TERMINATED'

function walkStatements(ctx: WalkContext, stmts: SyntaxNode[], prevId: string | null): string | null {
  let lastId = prevId
  for (const stmt of stmts) {
    const result = walkNode(ctx, stmt, lastId)
    if (result === TERMINATED) return null
    if (result !== null) lastId = result
  }
  return lastId
}

function walkNode(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  if (BRANCH_TYPES.has(node.type)) return walkBranch(ctx, node, prevId)
  if (SWITCH_TYPES.has(node.type)) return walkSwitch(ctx, node, prevId)
  if (LOOP_TYPES.has(node.type)) return walkLoop(ctx, node, prevId)
  if (TRY_TYPES.has(node.type)) return walkTry(ctx, node, prevId)
  if (GUARD_TYPES.has(node.type)) return walkGuard(ctx, node, prevId)
  if (CALL_TYPES.has(node.type)) return walkCallExpression(ctx, node, prevId)

  if (node.type === 'expression_statement') {
    const expr = node.namedChildren[0]
    if (expr) return walkNode(ctx, expr, prevId)
    return prevId
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const calls = collectCalls(node)
    if (calls.length === 0) return prevId
    let last = prevId
    for (const call of calls) {
      const isAw = call.parent?.type === 'await_expression'
      last = walkCallExpression(ctx, call, last, isAw)
    }
    return last
  }

  if (node.type === 'await_expression') {
    const inner = node.namedChildren[0]
    if (inner && CALL_TYPES.has(inner.type)) {
      return walkCallExpression(ctx, inner, prevId, true)
    }
    return prevId
  }

  const calls = collectCalls(node)
  if (calls.length > 0) {
    let last = prevId
    for (const call of calls) last = walkCallExpression(ctx, call, last)
    return last
  }

  return prevId
}

function walkCallExpression(ctx: WalkContext, node: SyntaxNode, prevId: string | null, isAwait = false): string | null {
  if (isPromiseChainMethod(node)) {
    return walkPromiseChain(ctx, node, prevId)
  }

  const name = extractCallName(node)
  if (isNoiseCall(ctx, name)) return prevId

  const targetNodeId = resolveCallTarget(ctx, node)
  const kind: CFNodeKind = isAwait ? 'await' : 'call'
  const label = isAwait ? `await ${name}` : name
  const cfNode = addNode(ctx, kind, label, node, { targetNodeId })

  if (prevId) addEdge(ctx, prevId, cfNode.id, 'next')
  return cfNode.id
}

function walkPromiseChain(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const steps = unwindPromiseChain(node)
  let lastId = prevId
  let chainEntryId: string | null = null

  for (const step of steps) {
    const method = isPromiseChainMethod(step)

    if (!method) {
      const name = extractCallName(step)
      if (isNoiseCall(ctx, name)) continue
      const targetNodeId = resolveCallTarget(ctx, step)
      const cfNode = addNode(ctx, 'call', name, step, { targetNodeId })
      if (lastId) addEdge(ctx, lastId, cfNode.id, 'next')
      lastId = cfNode.id
      chainEntryId = cfNode.id
      continue
    }

    const args = step.childForFieldName('arguments')
    const callback = args?.namedChildren[0]

    if (method === 'catch') {
      const catchNode = addNode(ctx, 'catch', '.catch()', step)
      if (chainEntryId) addEdge(ctx, chainEntryId, catchNode.id, 'catch_entry')
      if (callback) {
        const bodyLastId = walkCallbackBody(ctx, callback, catchNode.id)
        lastId = bodyLastId ?? catchNode.id
      } else {
        lastId = catchNode.id
      }
      continue
    }

    if (method === 'finally') {
      const finallyNode = addNode(ctx, 'finally', '.finally()', step)
      if (lastId) addEdge(ctx, lastId, finallyNode.id, 'finally_entry')
      if (callback) {
        const bodyLastId = walkCallbackBody(ctx, callback, finallyNode.id)
        lastId = bodyLastId ?? finallyNode.id
      } else {
        lastId = finallyNode.id
      }
      continue
    }

    // .then()
    if (callback) {
      if (CALL_TYPES.has(callback.type) || callback.type === 'identifier') {
        const name = callback.text.slice(0, 60)
        const targetNodeId = resolveCallTarget(ctx, step)
        const cfNode = addNode(ctx, 'call', name, callback, { targetNodeId })
        if (lastId) addEdge(ctx, lastId, cfNode.id, 'next')
        lastId = cfNode.id
      } else {
        const bodyLastId = walkCallbackBody(ctx, callback, lastId)
        lastId = bodyLastId ?? lastId
      }
    }
  }

  return lastId
}

function walkCallbackBody(ctx: WalkContext, callback: SyntaxNode, prevId: string | null): string | null {
  const body = callback.childForFieldName('body')
  if (!body) return prevId
  if (BODY_TYPES.has(body.type)) {
    return walkStatements(ctx, body.namedChildren, prevId)
  }
  return walkNode(ctx, body, prevId)
}

function walkBranch(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const condition = extractConditionText(node)
  const branchNode = addNode(ctx, 'branch', condition ? `if (${condition})` : 'if', node, { condition })
  if (prevId) addEdge(ctx, prevId, branchNode.id, 'next')

  const consequent = node.childForFieldName('consequence')
  const alternate = node.childForFieldName('alternative')

  let trueLastId: string | null = null
  if (consequent) {
    const nodesBefore = ctx.nodes.length
    const stmts = bodyStatements(consequent)
    trueLastId = walkStatements(ctx, stmts, null)
    const firstTrueNode = ctx.nodes[nodesBefore]
    if (firstTrueNode) {
      addEdge(ctx, branchNode.id, firstTrueNode.id, 'true')
    }
  }

  let falseLastId: string | null = null
  if (alternate) {
    const altChild = alternate.type === 'else_clause' ? alternate.namedChildren[0] : alternate
    if (altChild) {
      if (BRANCH_TYPES.has(altChild.type)) {
        falseLastId = walkBranch(ctx, altChild, null)
        const elseIfNode = ctx.nodes.find(
          (n) => n.line === ctx.functionStartLine + altChild.startPosition.row && n.kind === 'branch'
        )
        if (elseIfNode) addEdge(ctx, branchNode.id, elseIfNode.id, 'false')
      } else {
        const nodesBefore = ctx.nodes.length
        const stmts = bodyStatements(altChild)
        falseLastId = walkStatements(ctx, stmts, null)
        const firstFalseNode = ctx.nodes[nodesBefore]
        if (firstFalseNode) addEdge(ctx, branchNode.id, firstFalseNode.id, 'false')
      }
    }
  }

  if (trueLastId !== null && falseLastId !== null) return trueLastId
  if (trueLastId !== null) return trueLastId
  if (falseLastId !== null) return falseLastId
  return branchNode.id
}

function walkSwitch(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const switchBody = node.childForFieldName('body')
  if (!switchBody) return prevId

  const cases = switchBody.namedChildren.filter((c) => c.type === 'switch_case' || c.type === 'switch_default')
  if (cases.length === 0) return prevId

  let lastBranchId = prevId
  let lastExitId: string | null = null

  for (const caseNode of cases) {
    const isDefault = caseNode.type === 'switch_default'
    const caseValue = isDefault ? 'default' : (caseNode.childForFieldName('value')?.text?.slice(0, 40) ?? '')
    const label = isDefault ? 'default' : `case ${caseValue}`

    const branchCf = addNode(ctx, 'branch', label, caseNode, {
      condition: isDefault ? undefined : caseValue
    })

    if (lastBranchId) {
      addEdge(ctx, lastBranchId, branchCf.id, lastBranchId === prevId ? 'next' : 'false')
    }

    const bodyStmts = caseNode.namedChildren.filter(
      (c) => c.type !== 'string' && c.type !== 'number' && c.type !== 'identifier'
    )
    const nodesBefore = ctx.nodes.length
    const caseLastId = walkStatements(ctx, bodyStmts, null)

    if (caseLastId) {
      const firstCaseNode = ctx.nodes[nodesBefore]
      if (firstCaseNode) addEdge(ctx, branchCf.id, firstCaseNode.id, 'true')
      lastExitId = caseLastId
    }

    lastBranchId = branchCf.id
  }

  return lastExitId ?? lastBranchId
}

function walkLoop(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const text = node.text.split('{')[0]?.trim().slice(0, 80) ?? 'loop'
  const loopNode = addNode(ctx, 'loop', text, node)
  if (prevId) addEdge(ctx, prevId, loopNode.id, 'next')

  const body = node.childForFieldName('body')
  if (body) {
    const nodesBefore = ctx.nodes.length
    const stmts = bodyStatements(body)
    const bodyLastId = walkStatements(ctx, stmts, null)

    if (bodyLastId && bodyLastId !== loopNode.id) {
      const firstBodyNode = ctx.nodes[nodesBefore]
      if (firstBodyNode) addEdge(ctx, loopNode.id, firstBodyNode.id, 'loop_body')
      addEdge(ctx, bodyLastId, loopNode.id, 'loop_back')
    }
  }

  return loopNode.id
}

function walkTry(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const tryNode = addNode(ctx, 'try', 'try', node)
  if (prevId) addEdge(ctx, prevId, tryNode.id, 'next')

  const body = node.childForFieldName('body')
  let tryLastId: string | null = tryNode.id
  if (body) {
    const nodesBefore = ctx.nodes.length
    const stmts = bodyStatements(body)
    const bodyLast = walkStatements(ctx, stmts, null)
    if (bodyLast) {
      const firstTryNode = ctx.nodes[nodesBefore]
      if (firstTryNode) addEdge(ctx, tryNode.id, firstTryNode.id, 'try_body')
      tryLastId = bodyLast
    }
  }

  const handler = node.childForFieldName('handler')
  let catchLastId: string | null = null
  if (handler) {
    const catchNode = addNode(ctx, 'catch', 'catch', handler)
    addEdge(ctx, tryNode.id, catchNode.id, 'catch_entry')

    const catchBody = handler.childForFieldName('body')
    if (catchBody) {
      const stmts = bodyStatements(catchBody)
      catchLastId = walkStatements(ctx, stmts, catchNode.id)
    }
    if (!catchLastId) catchLastId = catchNode.id
  }

  const finalizer = node.childForFieldName('finalizer')
  if (finalizer) {
    const finallyNode = addNode(ctx, 'finally', 'finally', finalizer)
    if (tryLastId) addEdge(ctx, tryLastId, finallyNode.id, 'finally_entry')
    if (catchLastId) addEdge(ctx, catchLastId, finallyNode.id, 'finally_entry')

    const stmts = bodyStatements(finalizer)
    const finallyLastId = walkStatements(ctx, stmts, finallyNode.id)
    return finallyLastId ?? finallyNode.id
  }

  return tryLastId
}

function walkGuard(ctx: WalkContext, node: SyntaxNode, prevId: string | null): string | null {
  const isReturn = node.type === 'return_statement'
  const valueText = node.namedChildren[0]?.text?.slice(0, 60) ?? ''
  const label = isReturn ? (valueText ? `return ${valueText}` : 'return') : `throw ${valueText}`

  const guardNode = addNode(ctx, 'guard', label, node)
  if (prevId) addEdge(ctx, prevId, guardNode.id, 'next')
  return TERMINATED
}

// ── Entry point ────────────────────────────────────────────────────────────

const DEFAULT_NOISE_NAMES = new Set([
  'console',
  'log',
  'warn',
  'error',
  'info',
  'debug',
  'assert',
  'trace',
  'time',
  'timeEnd',
  'timeLog',
  'count',
  'countReset',
  'group',
  'groupEnd',
  'clear',
  'table',
  'dir'
])

export function extractBodyFlow(
  functionNode: Node,
  outgoingEdges: Edge[],
  tree: { rootNode: SyntaxNode },
  noiseNames?: Set<string>
): BodyFlow | null {
  resetIds()

  const funcStartLine = functionNode.startLine
  const funcEndLine = functionNode.endLine

  const astFunc = findFunctionNode(tree.rootNode, funcStartLine, funcEndLine)
  if (!astFunc) return null

  const body = astFunc.childForFieldName('body')
  if (!body) return null

  const signature = extractSignature(astFunc)
  const callTargets = buildCallTargetIndex(outgoingEdges)

  const ctx: WalkContext = {
    nodes: [],
    edges: [],
    callTargets,
    functionStartLine: 0,
    noiseNames: noiseNames ?? DEFAULT_NOISE_NAMES
  }

  const entryNode = addNode(ctx, 'entry', signature, astFunc)
  const stmts = bodyStatements(body)
  const lastId = walkStatements(ctx, stmts, entryNode.id)

  const exitNode = addNode(ctx, 'exit', 'exit', astFunc)
  if (lastId) addEdge(ctx, lastId, exitNode.id, 'next')

  for (const gn of ctx.nodes.filter((n) => n.kind === 'guard')) {
    if (!ctx.edges.some((e) => e.source === gn.id)) {
      addEdge(ctx, gn.id, exitNode.id, 'next')
    }
  }

  cleanupEdges(ctx)

  return {
    functionNodeId: functionNode.id,
    signature,
    nodes: ctx.nodes,
    edges: ctx.edges
  }
}

function cleanupEdges(ctx: WalkContext): void {
  const nodeIds = new Set(ctx.nodes.map((n) => n.id))
  ctx.edges = ctx.edges.filter(
    (e) => e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target
  )

  const seen = new Set<string>()
  ctx.edges = ctx.edges.filter((e) => {
    const key = `${e.source}\x00${e.target}\x00${e.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  ctx.nodes = ctx.nodes.filter((n) => {
    if (n.kind === 'entry' || n.kind === 'exit') return true
    if (n.label === '') {
      const connected = ctx.edges.some((e) => e.target === n.id || e.source === n.id)
      if (!connected) return false
    }
    return true
  })
}

function findFunctionNode(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  const funcTypes = new Set([
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function',
    'function_expression',
    'generator_function_declaration'
  ])

  function walk(node: SyntaxNode): SyntaxNode | null {
    if (funcTypes.has(node.type)) {
      const nodeStart = node.startPosition.row + 1
      const nodeEnd = node.endPosition.row + 1
      if (nodeStart === startLine || (nodeStart >= startLine - 1 && nodeEnd <= endLine + 1)) {
        return node
      }
    }
    for (const child of node.namedChildren) {
      const result = walk(child)
      if (result) return result
    }
    return null
  }

  return walk(root)
}

function extractSignature(node: SyntaxNode): string {
  const name = node.childForFieldName('name')?.text ?? ''
  const params = node.childForFieldName('parameters')?.text ?? ''
  const returnType = node.childForFieldName('return_type')?.text ?? ''
  const prefix = node.type === 'arrow_function' ? '' : 'function '
  const asyncMod = node.children.some((c) => c.type === 'async') ? 'async ' : ''
  const ret = returnType ? `: ${returnType}` : ''
  return `${asyncMod}${prefix}${name}${params}${ret}`.trim()
}
