import type { BodyFlow, CFEdge, CFEdgeKind, CFNode, CFNodeKind } from '@graphcoder/core'
import type { Edge, Node } from '@colbymchenry/codegraph'
import type { SyntaxNode } from './parser.js'

// ── Language profiles ──────────────────────────────────────────────────────

type ChainRole = 'then' | 'catch' | 'finally'

interface SwitchCase {
  node: SyntaxNode
  label: string
  isDefault: boolean
  body: SyntaxNode[]
}

interface TryParts {
  body: SyntaxNode | null
  handlers: Array<{ node: SyntaxNode; label: string; body: SyntaxNode | null }>
  /** Python `try … else`: runs when the body raised nothing */
  orElse: SyntaxNode | null
  finalizer: { node: SyntaxNode; body: SyntaxNode | null } | null
}

interface LanguageProfile {
  /** Declarations that own a body flow */
  functions: Set<string>
  /** Function-like nodes: defined here but run elsewhere, so never walked inline */
  closures: Set<string>
  /** Statement containers whose named children run in sequence */
  blocks: Set<string>
  branch: Set<string>
  ternary: Set<string>
  loop: Set<string>
  switch: Set<string>
  try: Set<string>
  return: Set<string>
  throw: Set<string>
  break: Set<string>
  continue: Set<string>
  fallthrough: Set<string>
  call: Set<string>
  await: Set<string>
  /** Calls and macros that never return (Go `panic`, Rust `panic!`) */
  diverging: Set<string>
  member: { type: string; object: string; property: string }
  /** Continuation methods unfolded into control flow (`.then`, `.and_then`) */
  chain: Map<string, ChainRole>
  /** `break` leaves a switch as well as a loop */
  switchBreaks: boolean
  /** A case body without a jump runs on into the next case body */
  implicitFallthrough: boolean
  /** Some case always matches (Rust `match`), so the ladder has no fall-out edge */
  exhaustive: boolean
  cases(node: SyntaxNode): SwitchCase[]
  tryParts(node: SyntaxNode): TryParts
  signature(fn: SyntaxNode, name: string): string
}

const set = (...types: string[]) => new Set(types)
const NO_TRY: TryParts = { body: null, handlers: [], orElse: null, finalizer: null }

const TS_FUNCTIONS = [
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'function',
  'generator_function'
]

const TYPESCRIPT: LanguageProfile = {
  functions: set(...TS_FUNCTIONS),
  closures: set(...TS_FUNCTIONS, 'class_declaration', 'class'),
  blocks: set('statement_block'),
  branch: set('if_statement'),
  ternary: set('ternary_expression'),
  loop: set('for_statement', 'for_in_statement', 'while_statement', 'do_statement'),
  switch: set('switch_statement'),
  try: set('try_statement'),
  return: set('return_statement'),
  throw: set('throw_statement'),
  break: set('break_statement'),
  continue: set('continue_statement'),
  fallthrough: set(),
  call: set('call_expression', 'new_expression'),
  await: set('await_expression'),
  diverging: set(),
  member: { type: 'member_expression', object: 'object', property: 'property' },
  chain: new Map([
    ['then', 'then'],
    ['catch', 'catch'],
    ['finally', 'finally']
  ]),
  switchBreaks: true,
  implicitFallthrough: true,
  exhaustive: false,
  cases: (node) =>
    (node.childForFieldName('body')?.namedChildren ?? [])
      .filter((c) => c.type === 'switch_case' || c.type === 'switch_default')
      .map((c) => {
        const isDefault = c.type === 'switch_default'
        const value = c.childForFieldName('value')?.text ?? ''
        return {
          node: c,
          isDefault,
          label: isDefault ? 'default' : clip(`case ${value}`, 50),
          body: c.childrenForFieldName('body')
        }
      }),
  tryParts: (node) => {
    const handler = node.childForFieldName('handler')
    const param = handler?.childForFieldName('parameter')
    const finalizer = node.childForFieldName('finalizer')
    return {
      body: node.childForFieldName('body'),
      handlers: handler
        ? [
            {
              node: handler,
              label: param ? clip(`catch (${param.text})`, 40) : 'catch',
              body: handler.childForFieldName('body')
            }
          ]
        : [],
      orElse: null,
      finalizer: finalizer ? { node: finalizer, body: finalizer.childForFieldName('body') } : null
    }
  },
  signature: (fn, name) => {
    const isAsync = fn.children.some((c) => c.type === 'async')
    const keyword = fn.type.startsWith('function') || fn.type.startsWith('generator') ? 'function ' : ''
    const typeParams = fn.childForFieldName('type_parameters')?.text ?? ''
    const params = (fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter'))?.text ?? '()'
    const ret = fn.childForFieldName('return_type')?.text.replace(/^:\s*/, '')
    return `${isAsync ? 'async ' : ''}${keyword}${name}${typeParams}${params}${ret ? `: ${ret}` : ''}`
  }
}

const PYTHON: LanguageProfile = {
  functions: set('function_definition'),
  closures: set('function_definition', 'lambda', 'class_definition'),
  blocks: set('block'),
  branch: set('if_statement'),
  ternary: set('conditional_expression'),
  loop: set('for_statement', 'while_statement'),
  switch: set('match_statement'),
  try: set('try_statement'),
  return: set('return_statement'),
  throw: set('raise_statement'),
  break: set('break_statement'),
  continue: set('continue_statement'),
  fallthrough: set(),
  call: set('call'),
  await: set('await'),
  diverging: set(),
  member: { type: 'attribute', object: 'object', property: 'attribute' },
  chain: new Map(),
  switchBreaks: false,
  implicitFallthrough: false,
  exhaustive: false,
  cases: (node) =>
    (node.childForFieldName('body')?.namedChildren ?? [])
      .filter((c) => c.type === 'case_clause')
      .map((c) => {
        const pattern = c.namedChildren
          .filter((p) => p.type === 'case_pattern')
          .map((p) => p.text)
          .join(', ')
        const guard = c.childForFieldName('guard')
        const consequence = c.childForFieldName('consequence')
        return {
          node: c,
          isDefault: pattern === '_' && !guard,
          label: clip(`case ${pattern}${guard ? ` ${guard.text}` : ''}`, 50),
          body: consequence ? [consequence] : []
        }
      }),
  tryParts: (node) => {
    const finalizer = node.namedChildren.find((c) => c.type === 'finally_clause')
    return {
      body: node.childForFieldName('body'),
      handlers: node.namedChildren
        .filter((c) => c.type === 'except_clause' || c.type === 'except_group_clause')
        .map((c) => {
          const caught = c.namedChildren.find((ch) => ch.type !== 'block' && !isComment(ch))
          return { node: c, label: caught ? clip(`except ${caught.text}`, 40) : 'except', body: lastBlock(c) }
        }),
      orElse: node.namedChildren.find((c) => c.type === 'else_clause')?.childForFieldName('body') ?? null,
      finalizer: finalizer ? { node: finalizer, body: lastBlock(finalizer) } : null
    }
  },
  signature: (fn, name) => {
    const isAsync = fn.children.some((c) => c.type === 'async')
    const ret = fn.childForFieldName('return_type')?.text
    return `${isAsync ? 'async ' : ''}def ${name}${fn.childForFieldName('parameters')?.text ?? '()'}${ret ? ` -> ${ret}` : ''}`
  }
}

const GO_CASES = set('expression_case', 'type_case', 'communication_case', 'default_case')

const GO: LanguageProfile = {
  functions: set('function_declaration', 'method_declaration'),
  closures: set('function_declaration', 'method_declaration', 'func_literal'),
  blocks: set('block', 'statement_list'),
  branch: set('if_statement'),
  ternary: set(),
  loop: set('for_statement'),
  switch: set('expression_switch_statement', 'type_switch_statement', 'select_statement'),
  try: set(),
  return: set('return_statement'),
  throw: set(),
  break: set('break_statement'),
  continue: set('continue_statement'),
  fallthrough: set('fallthrough_statement'),
  call: set('call_expression'),
  await: set(),
  diverging: set('panic', 'os.Exit', 'log.Fatal', 'log.Fatalf', 'log.Fatalln'),
  member: { type: 'selector_expression', object: 'operand', property: 'field' },
  chain: new Map(),
  switchBreaks: true,
  implicitFallthrough: false,
  exhaustive: false,
  cases: (node) =>
    node.namedChildren
      .filter((c) => GO_CASES.has(c.type))
      .map((c) => {
        const isDefault = c.type === 'default_case'
        const values =
          c.type === 'type_case'
            ? c.childrenForFieldName('type')
            : [c.childForFieldName('value') ?? c.childForFieldName('communication')].filter(
                (v): v is SyntaxNode => v !== null
              )
        return {
          node: c,
          isDefault,
          label: isDefault ? 'default' : clip(`case ${values.map((v) => v.text).join(', ')}`, 50),
          body: c.namedChildren.filter((ch) => ch.type === 'statement_list')
        }
      }),
  tryParts: () => NO_TRY,
  signature: (fn, name) => {
    const receiver = fn.childForFieldName('receiver')?.text
    const result = fn.childForFieldName('result')?.text
    return `func ${receiver ? `${receiver} ` : ''}${name}${fn.childForFieldName('parameters')?.text ?? '()'}${result ? ` ${result}` : ''}`
  }
}

const RUST: LanguageProfile = {
  functions: set('function_item'),
  closures: set('function_item', 'closure_expression'),
  blocks: set('block'),
  branch: set('if_expression'),
  ternary: set(),
  loop: set('for_expression', 'while_expression', 'loop_expression'),
  switch: set('match_expression'),
  try: set(),
  return: set('return_expression'),
  throw: set(),
  break: set('break_expression'),
  continue: set('continue_expression'),
  fallthrough: set(),
  call: set('call_expression'),
  await: set('await_expression'),
  diverging: set('panic', 'unreachable', 'unimplemented', 'todo'),
  member: { type: 'field_expression', object: 'value', property: 'field' },
  chain: new Map([
    ['and_then', 'then'],
    ['or_else', 'catch']
  ]),
  switchBreaks: false,
  implicitFallthrough: false,
  exhaustive: true,
  cases: (node) =>
    (node.childForFieldName('body')?.namedChildren ?? [])
      .filter((c) => c.type === 'match_arm')
      .map((c) => {
        const pattern = c.childForFieldName('pattern')?.text ?? ''
        const value = c.childForFieldName('value')
        return { node: c, isDefault: pattern === '_', label: clip(`${pattern} =>`, 50), body: value ? [value] : [] }
      }),
  tryParts: () => NO_TRY,
  signature: (fn, name) => {
    const isAsync = fn.namedChildren.some((c) => c.type === 'function_modifiers' && /\basync\b/.test(c.text))
    const ret = fn.childForFieldName('return_type')?.text
    return `${isAsync ? 'async ' : ''}fn ${name}${fn.childForFieldName('parameters')?.text ?? '()'}${ret ? ` -> ${ret}` : ''}`
  }
}

const PROFILES: Record<string, LanguageProfile> = {
  typescript: TYPESCRIPT,
  tsx: TYPESCRIPT,
  javascript: TYPESCRIPT,
  jsx: TYPESCRIPT,
  python: PYTHON,
  go: GO,
  rust: RUST
}

// ── Text helpers ───────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const isComment = (node: SyntaxNode) => node.type.endsWith('comment')
const sameNode = (a: SyntaxNode | null, b: SyntaxNode | null) => a !== null && b !== null && a.id === b.id
const lastSegment = (name: string) => name.split(/[.:]+/).pop() ?? name
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

function lastBlock(node: SyntaxNode): SyntaxNode | null {
  return last(node.namedChildren.filter((c) => c.type === 'block')) ?? null
}

function unparen(node: SyntaxNode): SyntaxNode {
  return node.type === 'parenthesized_expression' && node.namedChildren.length === 1 ? node.namedChildren[0]! : node
}

// ── Call target resolution ─────────────────────────────────────────────────

interface CallSite {
  line?: number
  column?: number
  target: string
  kind: string
  /** Last segment of the callee name CodeGraph recorded */
  name: string
  /** Synthetic HTTP-bridge edge: fetch() call → route handler */
  http?: { method: string; path: string }
}

function buildSites(edges: Edge[]): CallSite[] {
  return edges
    .filter((e) => e.kind === 'calls' || e.kind === 'references' || e.kind === 'instantiates')
    .map((e) => {
      const meta = e.metadata ?? {}
      const path = meta['matchedPath']
      return {
        line: e.line,
        column: e.column,
        target: e.target,
        kind: e.kind,
        name: lastSegment(typeof meta['refName'] === 'string' ? meta['refName'] : ''),
        ...(meta['synthetic'] && typeof path === 'string'
          ? { http: { method: String(meta['httpMethod'] ?? 'GET'), path } }
          : {})
      }
    })
}

function matchHttp(sites: CallSite[], call: SyntaxNode): string | null {
  const http = sites.filter((s) => s.http)
  if (http.length <= 1) return http[0]?.target ?? null
  const method = /method:\s*['"`](\w+)/i.exec(call.text)?.[1]?.toUpperCase() ?? 'GET'
  const fits = http.filter((s) => {
    const segments = s.http!.path.split('/').filter((seg) => seg && !seg.startsWith(':'))
    return s.http!.method === method && segments.every((seg) => call.text.includes(seg))
  })
  return fits.length === 1 ? fits[0]!.target : null
}

// ── Walk state ─────────────────────────────────────────────────────────────

/** An outgoing edge still waiting for its target: the next node to run. */
interface Exit {
  id: string
  kind: CFEdgeKind
}

interface JumpTarget {
  kind: 'loop' | 'switch'
  head?: string
  breaks: Exit[]
  /** Go `fallthrough` exits waiting for the next case body */
  fall: Exit[]
  uses: number
}

interface Ctx {
  profile: LanguageProfile
  sites: CallSite[]
  /** CodeGraph pins every call in a route handler to the route's own line */
  declarationLine: number
  nodes: CFNode[]
  edges: CFEdge[]
  guards: string[]
  jumps: JumpTarget[]
  /** One frame per callback body being walked — its `return`s end the callback, not the function */
  callbackReturns: Exit[][]
  /** Guards, jumps, and callback returns so far — control that leaves the enclosing structure */
  escapes: number
  /** >0 while walking a call's receiver or arguments */
  nested: number
  nextId: number
}

const next = (id: string): Exit[] => [{ id, kind: 'next' }]
const relabel = (exits: Exit[], kind: CFEdgeKind): Exit[] => exits.map((x) => ({ ...x, kind }))
const relabelNext = (exits: Exit[], kind: CFEdgeKind): Exit[] =>
  exits.map((x) => (x.kind === 'next' ? { ...x, kind } : x))

function addNode(ctx: Ctx, kind: CFNodeKind, label: string, at: SyntaxNode, extra: Partial<CFNode> = {}): CFNode {
  const node: CFNode = {
    id: `bf:${ctx.nextId++}`,
    kind,
    label,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
    ...extra
  }
  ctx.nodes.push(node)
  return node
}

function connect(ctx: Ctx, from: Exit[], to: string): void {
  for (const x of from) ctx.edges.push({ source: x.id, target: to, kind: x.kind })
}

interface Mark {
  nodes: number
  edges: number
  escapes: number
}

const mark = (ctx: Ctx): Mark => ({ nodes: ctx.nodes.length, edges: ctx.edges.length, escapes: ctx.escapes })

/** A structure is hollow when it produced only its own nodes and no control left it — nothing worth drawing. */
function hollow(ctx: Ctx, m: Mark, own: Set<string>, selfJumps = 0): boolean {
  return ctx.nodes.slice(m.nodes).every((n) => own.has(n.id)) && ctx.escapes === m.escapes + selfJumps
}

function rollback(ctx: Ctx, m: Mark): void {
  ctx.nodes.length = m.nodes
  ctx.edges.length = m.edges
  ctx.escapes = m.escapes
}

// ── Statement walkers ──────────────────────────────────────────────────────

function statements(ctx: Ctx, node: SyntaxNode): SyntaxNode[] {
  if (!ctx.profile.blocks.has(node.type)) return [node]
  return node.namedChildren.flatMap((c) =>
    isComment(c) ? [] : ctx.profile.blocks.has(c.type) ? statements(ctx, c) : [c]
  )
}

/** `tail`: the statements end the function, so a final `return` is a normal exit rather than a guard. */
function walkStatements(ctx: Ctx, stmts: SyntaxNode[], entry: Exit[], tail: boolean): Exit[] {
  let exits = entry
  for (let i = 0; i < stmts.length && exits.length > 0; i++) {
    exits = walkNode(ctx, stmts[i]!, exits, tail && i === stmts.length - 1)
  }
  return exits
}

function walkBody(ctx: Ctx, node: SyntaxNode | null | undefined, entry: Exit[], tail: boolean): Exit[] {
  return node ? walkStatements(ctx, statements(ctx, node), entry, tail) : entry
}

/** Walk an expression whose text the enclosing node already shows (a condition, a loop header): only linked calls get nodes. */
function walkQuoted(ctx: Ctx, node: SyntaxNode | null, entry: Exit[]): Exit[] {
  if (!node || entry.length === 0) return entry
  ctx.nested++
  const exits = walkNode(ctx, node, entry, false)
  ctx.nested--
  return exits
}

/** Children in order; a `body` child (Python `with`, Rust `unsafe`) keeps the tail position of its parent. */
function walkChildren(ctx: Ctx, node: SyntaxNode, entry: Exit[], tail = false): Exit[] {
  const body = node.childForFieldName('body')
  let exits = entry
  for (const child of node.namedChildren) {
    if (exits.length === 0) break
    exits = sameNode(child, body) ? walkBody(ctx, child, exits, tail) : walkNode(ctx, child, exits, false)
  }
  return exits
}

function walkNode(ctx: Ctx, node: SyntaxNode, entry: Exit[], tail: boolean): Exit[] {
  const p = ctx.profile
  const t = node.type
  if (isComment(node) || p.closures.has(t) || t === 'assert_statement') return entry
  if (p.branch.has(t)) return walkIf(ctx, node, entry, tail)
  if (p.loop.has(t)) return walkLoop(ctx, node, entry)
  if (p.switch.has(t)) return walkSwitch(ctx, node, entry)
  if (p.try.has(t)) return walkTry(ctx, node, entry, tail)
  if (p.return.has(t)) return walkReturn(ctx, node, entry, tail)
  if (p.throw.has(t) || isDiverging(ctx, node)) return walkThrow(ctx, node, entry)
  if (p.break.has(t)) return walkBreak(ctx, entry)
  if (p.continue.has(t)) return walkJump(ctx, 'loop', entry)
  if (p.fallthrough.has(t)) return walkJump(ctx, 'switch', entry)
  if (p.blocks.has(t)) return walkBody(ctx, node, entry, tail)
  if (p.ternary.has(t)) return walkTernary(ctx, node, entry)
  if (p.call.has(t)) return walkCall(ctx, node, entry)
  if (t === 'expression_statement') return walkStatements(ctx, node.namedChildren, entry, tail)
  if (t === 'defer_statement' || t === 'go_statement') {
    const call = node.namedChildren.find((c) => p.call.has(c.type))
    return call ? walkCall(ctx, call, entry, `${t.split('_')[0]} `) : entry
  }
  if (t === 'let_declaration' && node.childForFieldName('alternative')) return walkLetElse(ctx, node, entry)
  return walkChildren(ctx, node, entry, tail)
}

function isDiverging(ctx: Ctx, node: SyntaxNode): boolean {
  const { diverging, call } = ctx.profile
  if (diverging.size === 0) return false
  if (node.type === 'macro_invocation') return diverging.has(node.childForFieldName('macro')?.text ?? '')
  return call.has(node.type) && diverging.has(node.childForFieldName('function')?.text ?? '')
}

function walkIf(ctx: Ctx, node: SyntaxNode, entry: Exit[], tail: boolean): Exit[] {
  const init = node.childForFieldName('initializer')
  const exits = walkQuoted(ctx, node.childForFieldName('condition'), init ? walkNode(ctx, init, entry, false) : entry)
  if (exits.length === 0) return exits

  const m = mark(ctx)
  const own = new Set<string>()
  const branch = addBranch(ctx, 'if', node, node.childForFieldName('condition'), own)
  connect(ctx, exits, branch)

  const merged = [...walkBody(ctx, node.childForFieldName('consequence'), [{ id: branch, kind: 'true' }], tail)]
  let falseExits: Exit[] = [{ id: branch, kind: 'false' }]
  for (const alt of node.childrenForFieldName('alternative')) {
    if (alt.type !== 'elif_clause') {
      const body =
        alt.type === 'else_clause'
          ? (alt.childForFieldName('body') ?? alt.namedChildren.find((c) => !isComment(c)))
          : alt
      falseExits = walkBody(ctx, body, falseExits, tail)
      continue
    }
    const cond = alt.childForFieldName('condition')
    falseExits = walkQuoted(ctx, cond, falseExits)
    if (falseExits.length === 0) break
    const elif = addBranch(ctx, 'elif', alt, cond, own)
    connect(ctx, falseExits, elif)
    merged.push(...walkBody(ctx, alt.childForFieldName('consequence'), [{ id: elif, kind: 'true' }], tail))
    falseExits = [{ id: elif, kind: 'false' }]
  }

  if (hollow(ctx, m, own)) {
    rollback(ctx, m)
    return exits
  }
  return [...merged, ...falseExits]
}

function addBranch(ctx: Ctx, keyword: string, at: SyntaxNode, cond: SyntaxNode | null, own: Set<string>): string {
  const text = cond?.text ?? ''
  const node = addNode(ctx, 'branch', clip(`${keyword} ${text}`, 80), at, { condition: cond ? unparen(cond).text : '' })
  own.add(node.id)
  return node.id
}

function walkTernary(ctx: Ctx, node: SyntaxNode, entry: Exit[]): Exit[] {
  // Python's conditional_expression has no field names: `consequence if condition else alternative`
  const [first, second, third] = node.namedChildren
  const condition = node.childForFieldName('condition') ?? second ?? null
  const consequence = node.childForFieldName('consequence') ?? first
  const alternative = node.childForFieldName('alternative') ?? third

  const exits = walkQuoted(ctx, condition, entry)
  if (exits.length === 0) return exits

  const m = mark(ctx)
  const own = new Set<string>()
  const branch = addNode(ctx, 'branch', clip(`${condition?.text ?? ''} ?`, 80), node, {
    condition: condition ? unparen(condition).text : ''
  })
  own.add(branch.id)
  connect(ctx, exits, branch.id)
  const whenTrue = consequence ? walkNode(ctx, consequence, [{ id: branch.id, kind: 'true' }], false) : []
  const whenFalse = alternative ? walkNode(ctx, alternative, [{ id: branch.id, kind: 'false' }], false) : []

  if (hollow(ctx, m, own)) {
    rollback(ctx, m)
    return exits
  }
  return [...whenTrue, ...whenFalse]
}

function loopLabel(node: SyntaxNode, body: SyntaxNode | null): string {
  if (node.type === 'do_statement') return clip(`do … while ${node.childForFieldName('condition')?.text ?? ''}`, 80)
  const header = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text
  return clip(header.replace(/[\s{:]+$/, ''), 80) || 'loop'
}

function walkLoop(ctx: Ctx, node: SyntaxNode, entry: Exit[]): Exit[] {
  const body = node.childForFieldName('body')
  const orElse = node.childForFieldName('alternative')
  const isDo = node.type === 'do_statement'
  const header = isDo
    ? []
    : node.namedChildren.filter((c) => !sameNode(c, body) && !sameNode(c, orElse) && !isComment(c))

  let exits = entry
  for (const part of header) exits = walkQuoted(ctx, part, exits)
  if (exits.length === 0) return exits

  const m = mark(ctx)
  const loop = addNode(ctx, 'loop', loopLabel(node, body), node)
  connect(ctx, exits, loop.id)

  const target: JumpTarget = { kind: 'loop', head: loop.id, breaks: [], fall: [], uses: 0 }
  ctx.jumps.push(target)
  let bodyExits = walkBody(ctx, body, [{ id: loop.id, kind: 'loop_body' }], false)
  if (isDo) bodyExits = walkQuoted(ctx, node.childForFieldName('condition'), bodyExits)
  ctx.jumps.pop()
  connect(ctx, relabelNext(bodyExits, 'loop_back'), loop.id)

  const cond = node.childForFieldName('condition')
  const condText = cond ? unparen(cond).text : ''
  const infinite =
    node.type === 'loop_expression' ||
    condText === 'true' ||
    condText === 'True' ||
    (node.type === 'for_statement' && header.length === 0)
  let out: Exit[] = infinite ? [] : [{ id: loop.id, kind: 'loop_exit' }]
  if (orElse) out = walkBody(ctx, orElse.childForFieldName('body') ?? orElse, out, false)
  out = [...out, ...relabelNext(target.breaks, 'loop_exit')]

  if (hollow(ctx, m, new Set([loop.id]), target.uses)) {
    rollback(ctx, m)
    return exits
  }
  return out
}

/** Cases become an if/else-if ladder of branch nodes; `default` takes the final false edge. */
function walkSwitch(ctx: Ctx, node: SyntaxNode, entry: Exit[]): Exit[] {
  const p = ctx.profile
  const init = node.childForFieldName('initializer')
  const subjectNode = node.childForFieldName('value') ?? node.childForFieldName('subject')
  const exits = walkQuoted(ctx, subjectNode, init ? walkNode(ctx, init, entry, false) : entry)
  const cases = p.cases(node)
  if (exits.length === 0 || cases.length === 0) return exits

  const subject = subjectNode ? clip(unparen(subjectNode).text, 40) : ''
  const m = mark(ctx)
  const own = new Set<string>()
  const target: JumpTarget = { kind: 'switch', breaks: [], fall: [], uses: 0 }
  if (p.switchBreaks) ctx.jumps.push(target)

  let test = exits
  const caseIds = new Map<SwitchCase, string>()
  for (const c of cases) {
    if (c.isDefault) continue
    const n = addNode(ctx, 'branch', c.label, c.node, { condition: subject ? `${subject}: ${c.label}` : c.label })
    own.add(n.id)
    connect(ctx, test, n.id)
    caseIds.set(c, n.id)
    test = [{ id: n.id, kind: 'false' }]
  }

  const out: Exit[] = []
  let fall: Exit[] = []
  for (const c of cases) {
    const id = caseIds.get(c)
    const into: Exit[] = id ? [{ id, kind: 'true' }] : test
    if (!id) test = []
    const end = walkStatements(ctx, c.body, [...into, ...fall], false)
    if (p.implicitFallthrough) {
      fall = end
    } else {
      out.push(...end)
      fall = target.fall.splice(0)
    }
  }
  out.push(...fall, ...(p.exhaustive ? [] : test))
  if (p.switchBreaks) {
    ctx.jumps.pop()
    out.push(...target.breaks)
  }

  if (hollow(ctx, m, own, target.uses)) {
    rollback(ctx, m)
    return exits
  }
  return out
}

function walkTry(ctx: Ctx, node: SyntaxNode, entry: Exit[], tail: boolean): Exit[] {
  const parts = ctx.profile.tryParts(node)
  const inner = tail && !parts.finalizer
  const m = mark(ctx)
  const own = new Set<string>()

  const tryNode = addNode(ctx, 'try', 'try', node)
  own.add(tryNode.id)
  connect(ctx, entry, tryNode.id)
  let exits = walkBody(ctx, parts.body, [{ id: tryNode.id, kind: 'try_body' }], inner && !parts.orElse)
  if (parts.orElse) exits = walkBody(ctx, parts.orElse, exits, inner)

  for (const handler of parts.handlers) {
    const c = addNode(ctx, 'catch', handler.label, handler.node)
    own.add(c.id)
    ctx.edges.push({ source: tryNode.id, target: c.id, kind: 'catch_entry' })
    exits = [...exits, ...walkBody(ctx, handler.body, next(c.id), inner)]
  }

  if (parts.finalizer) {
    const f = addNode(ctx, 'finally', 'finally', parts.finalizer.node)
    own.add(f.id)
    connect(ctx, relabel(exits.length > 0 ? exits : next(tryNode.id), 'finally_entry'), f.id)
    exits = walkBody(ctx, parts.finalizer.body, next(f.id), tail)
  }

  if (hollow(ctx, m, own)) {
    rollback(ctx, m)
    return entry
  }
  return exits
}

function addGuard(ctx: Ctx, label: string, at: SyntaxNode, entry: Exit[]): Exit[] {
  const guard = addNode(ctx, 'guard', label, at)
  connect(ctx, entry, guard.id)
  ctx.guards.push(guard.id)
  ctx.escapes++
  return []
}

function walkReturn(ctx: Ctx, node: SyntaxNode, entry: Exit[], tail: boolean): Exit[] {
  const value = node.namedChildren.find((c) => !isComment(c))
  const before = ctx.nodes.length
  const exits = value ? walkNode(ctx, value, entry, false) : entry
  if (exits.length === 0) return exits

  const frame = last(ctx.callbackReturns)
  if (frame) {
    frame.push(...exits)
    ctx.escapes++
    return []
  }
  if (tail) return exits

  // `return f(x)` already drew f as a node — the guard only needs the keyword
  const shown = ctx.nodes.length > before && (ctx.profile.call.has(value!.type) || ctx.profile.await.has(value!.type))
  return addGuard(ctx, value && !shown ? clip(`return ${value.text}`, 60) : 'return', node, exits)
}

function walkThrow(ctx: Ctx, node: SyntaxNode, entry: Exit[]): Exit[] {
  return addGuard(ctx, clip(node.text.replace(/;$/, ''), 60), node, entry)
}

function walkBreak(ctx: Ctx, entry: Exit[]): Exit[] {
  const target = last(ctx.jumps)
  if (!target) return entry
  target.breaks.push(...entry)
  target.uses++
  ctx.escapes++
  return []
}

/** `continue` returns to the innermost loop head; Go `fallthrough` enters the next case body. */
function walkJump(ctx: Ctx, kind: JumpTarget['kind'], entry: Exit[]): Exit[] {
  const target = [...ctx.jumps].reverse().find((j) => j.kind === kind)
  if (!target) return entry
  if (target.head) connect(ctx, relabelNext(entry, 'loop_back'), target.head)
  else target.fall.push(...entry)
  target.uses++
  ctx.escapes++
  return []
}

/** Rust `let PATTERN = value else { … }` — the else block runs when the pattern fails. */
function walkLetElse(ctx: Ctx, node: SyntaxNode, entry: Exit[]): Exit[] {
  const value = node.childForFieldName('value')
  const exits = value ? walkNode(ctx, value, entry, false) : entry
  if (exits.length === 0) return exits
  const pattern = node.childForFieldName('pattern')?.text ?? ''
  const branch = addNode(ctx, 'branch', clip(`let ${pattern} else`, 80), node, { condition: pattern })
  connect(ctx, exits, branch.id)
  const orElse = walkBody(ctx, node.childForFieldName('alternative'), [{ id: branch.id, kind: 'false' }], false)
  return [{ id: branch.id, kind: 'true' }, ...orElse]
}

// ── Calls ──────────────────────────────────────────────────────────────────

function callee(call: SyntaxNode): SyntaxNode | null {
  const fn = call.childForFieldName('function') ?? call.childForFieldName('constructor')
  return fn ? unparen(fn) : null
}

function calleeName(ctx: Ctx, fn: SyntaxNode | null): string {
  if (!fn) return ''
  const m = ctx.profile.member
  if (fn.type === m.type) return fn.childForFieldName(m.property)?.text ?? ''
  return fn.childForFieldName('name')?.text ?? lastSegment(fn.text)
}

function callLabel(ctx: Ctx, call: SyntaxNode, fn: SyntaxNode | null): string {
  const m = ctx.profile.member
  let name = fn?.text ?? call.text.split('(')[0] ?? ''
  if (fn && ctx.profile.closures.has(fn.type)) name = '(anonymous)'
  else if (fn?.type === m.type) {
    const obj = fn.childForFieldName(m.object)
    const prop = fn.childForFieldName(m.property)
    if (obj && prop) name = `${clip(obj.text, 30)}.${prop.text}`
  }
  return clip(call.type === 'new_expression' ? `new ${name}` : name, 60)
}

const LOGGERS = set('console', 'logger', 'log', 'logging')
/** Output, assertions, and value helpers — dropped unless the call links to a graph node */
const NOISE_CALLEES = set(
  'print',
  'println',
  'assert',
  'fmt.Print',
  'fmt.Printf',
  'fmt.Println',
  'len',
  'cap',
  'append',
  'make',
  'range',
  'enumerate',
  'zip',
  'isinstance',
  'str',
  'int',
  'float',
  'bool',
  'String',
  'Number',
  'Boolean',
  'Ok',
  'Err',
  'Some'
)

function isNoise(ctx: Ctx, fn: SyntaxNode | null, resolved: boolean): boolean {
  if (!fn) return false
  const m = ctx.profile.member
  if (fn.type === m.type && LOGGERS.has(lastSegment(fn.childForFieldName(m.object)?.text ?? ''))) return true
  return !resolved && NOISE_CALLEES.has(fn.text)
}

function resolveTarget(ctx: Ctx, node: SyntaxNode, name: string, kinds: Set<string>): string | null {
  const line = node.startPosition.row + 1
  const column = node.startPosition.column
  const onLine = ctx.sites.filter((s) => s.line === line && kinds.has(s.kind))
  const named = onLine.filter((s) => s.name === name)
  const hit =
    named.find((s) => s.column === column) ??
    named[0] ??
    onLine.find((s) => s.column === column && !s.name) ??
    ctx.sites.find((s) => s.line === ctx.declarationLine && kinds.has(s.kind) && s.name === name)
  if (hit) return hit.target
  return name === 'fetch' ? matchHttp(ctx.sites, node) : null
}

const CALLS = set('calls')
const INSTANTIATES = set('calls', 'instantiates')
const CALLS_AND_REFERENCES = set('calls', 'references')

function walkCall(ctx: Ctx, call: SyntaxNode, entry: Exit[], prefix = ''): Exit[] {
  if (chainRole(ctx, call)) return walkChain(ctx, call, entry)

  const fn = callee(call)
  const m = ctx.profile.member
  const nested = ctx.nested > 0
  let exits = entry
  ctx.nested++
  const receiver = fn?.type === m.type ? fn.childForFieldName(m.object) : null
  if (receiver) exits = walkNode(ctx, receiver, exits, false)
  const args = call.childForFieldName('arguments')
  if (args && exits.length > 0) exits = walkNode(ctx, args, exits, false)
  ctx.nested--
  if (exits.length === 0) return exits

  // Calls buried in another call's receiver or arguments only earn a node when they link to the graph
  const kinds = call.type === 'new_expression' ? INSTANTIATES : CALLS
  const targetNodeId = resolveTarget(ctx, call, calleeName(ctx, fn), kinds)
  if ((nested && !targetNodeId) || isNoise(ctx, fn, targetNodeId !== null)) return exits

  const awaited = ctx.profile.await.has(call.parent?.type ?? '')
  const label = `${prefix}${awaited ? 'await ' : ''}${callLabel(ctx, call, fn)}`
  const node = addNode(ctx, awaited ? 'await' : 'call', label, call, { targetNodeId })
  connect(ctx, exits, node.id)
  return next(node.id)
}

function chainRole(ctx: Ctx, call: SyntaxNode): ChainRole | undefined {
  const fn = call.childForFieldName('function')
  const m = ctx.profile.member
  if (fn?.type !== m.type) return undefined
  return ctx.profile.chain.get(fn.childForFieldName(m.property)?.text ?? '')
}

/** Unfold `a().then(f).catch(g).finally(h)` into execution order, like the equivalent try/await code. */
function walkChain(ctx: Ctx, call: SyntaxNode, entry: Exit[]): Exit[] {
  const m = ctx.profile.member
  const steps: SyntaxNode[] = []
  let root: SyntaxNode | null = call
  while (root && ctx.profile.call.has(root.type) && chainRole(ctx, root)) {
    steps.unshift(root)
    root = root.childForFieldName('function')?.childForFieldName(m.object) ?? null
  }

  const start = ctx.nodes.length
  let exits = root ? walkNode(ctx, root, entry, false) : entry
  // The root call is drawn after any linked calls in its arguments, so it is the last node added
  const rootId = ctx.nodes.length > start ? last(ctx.nodes)!.id : undefined

  for (const step of steps) {
    if (exits.length === 0) break
    const role = chainRole(ctx, step)!
    const callback = step.childForFieldName('arguments')?.namedChildren.find((c) => !isComment(c))
    if (role === 'then') {
      exits = walkCallback(ctx, callback, exits)
      continue
    }
    const method = step.childForFieldName('function')?.childForFieldName(m.property)?.text ?? role
    const handler = addNode(ctx, role, `.${method}()`, step)
    if (role === 'catch') {
      if (rootId) ctx.edges.push({ source: rootId, target: handler.id, kind: 'catch_entry' })
      else connect(ctx, relabel(exits, 'catch_entry'), handler.id)
      exits = [...exits, ...walkCallback(ctx, callback, next(handler.id))]
    } else {
      connect(ctx, relabel(exits, 'finally_entry'), handler.id)
      exits = walkCallback(ctx, callback, next(handler.id))
    }
  }
  return exits
}

function walkCallback(ctx: Ctx, callback: SyntaxNode | undefined, entry: Exit[]): Exit[] {
  if (!callback) return entry
  const body = ctx.profile.closures.has(callback.type) ? callback.childForFieldName('body') : null
  if (body) {
    ctx.callbackReturns.push([])
    const end = walkBody(ctx, body, entry, false)
    return [...end, ...ctx.callbackReturns.pop()!]
  }
  const targetNodeId = resolveTarget(ctx, callback, lastSegment(callback.text), CALLS_AND_REFERENCES)
  const node = addNode(ctx, 'call', clip(callback.text, 60), callback, { targetNodeId })
  connect(ctx, entry, node.id)
  return next(node.id)
}

// ── Simplification ─────────────────────────────────────────────────────────

const MIN_BLOCK_CALLS = 3

/** Merge each run of 3+ calls with no branching between them into one `block` node. */
function mergeCallRuns(nodes: CFNode[], edges: CFEdge[]): { nodes: CFNode[]; edges: CFEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, CFEdge[]>()
  const incoming = new Map<string, number>()
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e])
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
  }
  const isCall = (n: CFNode | undefined) => n?.kind === 'call' || n?.kind === 'await'
  const successor = (n: CFNode): CFNode | undefined => {
    const out = outgoing.get(n.id) ?? []
    if (out.length !== 1 || out[0]!.kind !== 'next') return undefined
    const s = byId.get(out[0]!.target)
    return isCall(s) && incoming.get(s!.id) === 1 ? s : undefined
  }

  const continuation = new Set<string>()
  for (const n of nodes) {
    const s = isCall(n) ? successor(n) : undefined
    if (s) continuation.add(s.id)
  }

  const removed = new Set<string>()
  for (const head of nodes) {
    if (!isCall(head) || continuation.has(head.id)) continue
    const run = [head]
    for (let s = successor(head); s; s = successor(s)) run.push(s)
    if (run.length < MIN_BLOCK_CALLS) continue

    head.calls = run.map((c) => ({
      label: c.label,
      line: c.line,
      targetNodeId: c.targetNodeId ?? null,
      ...(c.kind === 'await' ? { await: true } : {})
    }))
    head.kind = 'block'
    head.label = run.map((c) => c.label).join(', ')
    delete head.targetNodeId
    for (const c of run.slice(1)) removed.add(c.id)
    for (const e of outgoing.get(last(run)!.id) ?? []) e.source = head.id
  }

  return {
    nodes: nodes.filter((n) => !removed.has(n.id)),
    edges: edges.filter((e) => !removed.has(e.source) && !removed.has(e.target))
  }
}

function dedupeEdges(edges: CFEdge[]): CFEdge[] {
  const seen = new Set<string>()
  return edges.filter((e) => {
    const key = `${e.source}\x00${e.target}\x00${e.kind}`
    if (e.source === e.target || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Entry point ────────────────────────────────────────────────────────────

function functionName(fn: SyntaxNode): string {
  const own = fn.childForFieldName('name')
  if (own) return own.text
  const parent = fn.parent
  if (parent?.type === 'variable_declarator') return parent.childForFieldName('name')?.text ?? ''
  if (parent?.type === 'pair') return parent.childForFieldName('key')?.text ?? ''
  if (parent?.type === 'assignment_expression') return parent.childForFieldName('left')?.text ?? ''
  return ''
}

/** The AST function for a CodeGraph node: same start line (column, then name, break ties), else the outermost inside its range. */
function findFunction(root: SyntaxNode, target: Node, profile: LanguageProfile): SyntaxNode | null {
  const onLine: SyntaxNode[] = []
  let within: SyntaxNode | null = null
  const walk = (node: SyntaxNode): void => {
    const start = node.startPosition.row + 1
    const end = node.endPosition.row + 1
    if (end < target.startLine - 1 || start > target.endLine + 1) return
    if (profile.functions.has(node.type)) {
      if (start === target.startLine) onLine.push(node)
      else if (!within && start >= target.startLine - 1 && end <= target.endLine + 1) within = node
    }
    for (const child of node.namedChildren) walk(child)
  }
  walk(root)
  return (
    onLine.find((n) => n.startPosition.column === target.startColumn) ??
    onLine.find((n) => functionName(n) === target.name) ??
    onLine[0] ??
    within
  )
}

export function extractBodyFlow(
  functionNode: Node,
  outgoingEdges: Edge[],
  tree: { rootNode: SyntaxNode },
  language: string
): BodyFlow | null {
  const profile = PROFILES[language]
  if (!profile) return null
  const fn = findFunction(tree.rootNode, functionNode, profile)
  const body = fn?.childForFieldName('body')
  if (!fn || !body) return null

  const ctx: Ctx = {
    profile,
    sites: buildSites(outgoingEdges),
    declarationLine: functionNode.startLine,
    nodes: [],
    edges: [],
    guards: [],
    jumps: [],
    callbackReturns: [],
    escapes: 0,
    nested: 0,
    nextId: 0
  }

  const name = functionName(fn)
  const entry = addNode(ctx, 'entry', clip(name || functionNode.name || 'entry', 60), fn)
  const exits = walkBody(ctx, body, next(entry.id), true)
  const exit = addNode(ctx, 'exit', 'exit', fn, { line: fn.endPosition.row + 1 })
  connect(ctx, exits, exit.id)
  for (const guard of ctx.guards) connect(ctx, next(guard), exit.id)

  const { nodes, edges } = mergeCallRuns(ctx.nodes, dedupeEdges(ctx.edges))
  return {
    functionNodeId: functionNode.id,
    signature: clip(
      profile
        .signature(fn, name)
        .replace(/\(\s+/g, '(')
        .replace(/,?\s+\)/g, ')'),
      200
    ),
    nodes,
    edges
  }
}
