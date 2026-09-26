// codegraph names the symbols; tree-sitter finds each one's whole declaration
// and judges the syntax. codegraph covers 30+ languages; for the ones with a
// grammar here (TS/JS, Python, Rust, Go) spans widen to the full declaration
// and edits get a syntax check. Other languages use codegraph's spans as-is.
//
// Never initialise codegraph's WASM grammars in this process: its native
// kernel then refuses a file that does not parse, instead of returning a
// partial symbol table from an error-recovering parse.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { startsLine } from '../text.js'
import { EditError, type Analysis, type Analyzer, type Declaration, type SyntaxProblem } from '../types.js'
import { GENERIC_TRAITS, profileFor, type LanguageProfile, type SyntaxNode } from './languages.js'

const require = createRequire(import.meta.url)

/** A codegraph symbol, as `extractFromSource` returns it. Columns are JS string indices. */
interface CgNode {
  kind: string
  name: string
  qualifiedName: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  signature?: string
}

const NOT_SYMBOLS = new Set(['file', 'import', 'export', 'parameter'])

type Extract = (path: string, text: string) => CgNode[]

let extractFn: Extract | undefined

function extractor(): Extract {
  if (extractFn) return extractFn
  let mod: { extractFromSource: (p: string, t: string) => { nodes: CgNode[] } }
  try {
    // The compiled library ships in codegraph's per-platform package; the
    // standalone extractor is not re-exported from its main entry.
    const sdk = require.resolve('@colbymchenry/codegraph')
    const lib = createRequire(sdk).resolve(
      `@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/index.js`
    )
    mod = require(join(dirname(lib), 'extraction', 'index.js'))
  } catch (err) {
    throw new EditError(
      `codegraph's extractor is unavailable on ${process.platform}-${process.arch}: ${(err as Error).message}`
    )
  }
  extractFn = (path, text) => mod.extractFromSource(path, text).nodes.filter((n) => !NOT_SYMBOLS.has(n.kind))
  return extractFn
}

const parsers = new Map<string, { parse(text: string): { rootNode: SyntaxNode } }>()

function parserFor(profile: LanguageProfile) {
  let parser = parsers.get(profile.id)
  if (!parser) {
    const Parser = require('tree-sitter')
    parser = new Parser()
    ;(parser as unknown as { setLanguage(l: unknown): void }).setLanguage(profile.grammar())
    parsers.set(profile.id, parser!)
  }
  return parser!
}

export function createAnalyzer(): Analyzer {
  return { analyze }
}

function analyze(path: string, text: string): Analysis {
  const profile = profileFor(path)
  const root = profile ? parserFor(profile).parse(text).rootNode : undefined
  const lines = lineStarts(text)
  const offset = (line: number, column: number) => Math.min((lines[line - 1] ?? text.length) + column, text.length)
  const nodes = extractor()(path, text)
  const spans = nodes.map((n) => ({ start: offset(n.startLine, n.startColumn), end: offset(n.endLine, n.endColumn) }))
  const lineAt = (o: number) => upperBound(lines, o)

  const declarations = nodes.map((n, i): Declaration => {
    const region =
      root && profile
        ? widen(root, profile, text, spans, i, n.name)
        : { end: spans[i].end, triviaStart: spans[i].start, headStart: spans[i].start }
    const end = region.end
    return {
      name: n.name,
      qualifiedName: n.qualifiedName,
      kind: n.kind,
      ...(n.signature ? { signature: n.signature } : {}),
      ...(region.overloadStart !== undefined ? { overloadStart: region.overloadStart } : {}),
      triviaStart: region.triviaStart,
      ...(region.decoratorStart !== undefined ? { decoratorStart: region.decoratorStart } : {}),
      headStart: region.headStart,
      ...(region.exportPrefix ? { exportPrefix: region.exportPrefix } : {}),
      ...(region.value ? { value: region.value } : {}),
      end,
      startLine: lineAt(region.overloadStart ?? region.triviaStart),
      line: lineAt(region.headStart),
      endLine: lineAt(Math.max(region.headStart, end - 1))
    }
  })

  const checked = profile?.validate?.(text)
  const syntaxError = checked !== undefined ? checked : root?.hasError ? firstError(root) : undefined
  return {
    checked: profile !== undefined,
    ...(syntaxError ? { syntaxError } : {}),
    declarations,
    traits: profile?.traits ?? GENERIC_TRAITS
  }
}

interface Region {
  end: number
  overloadStart?: number
  triviaStart: number
  decoratorStart?: number
  headStart: number
  exportPrefix?: string
  value?: { start: number; end: number }
}

/** Comments that belong to the file or module, never to the declaration below: a shebang, Rust inner docs. */
const FILE_COMMENT = /^(?:#!|\/\/!|\/\*!)/

function widen(
  root: SyntaxNode,
  profile: LanguageProfile,
  text: string,
  spans: Array<{ start: number; end: number }>,
  i: number,
  name: string
): Region {
  const { start: s, end: e } = spans[i]
  let core = root.namedDescendantForIndex(s, Math.max(s, e - 1))
  while (core.parent && (core.startIndex > s || core.endIndex < e)) core = core.parent
  // codegraph and the grammar disagree about this symbol: trust codegraph's span.
  if (core === root || !core.parent) return { end: e, triviaStart: s, headStart: s }

  const holdsOther = (n: SyntaxNode, inner: SyntaxNode) =>
    spans.some(
      (o, j) =>
        j !== i &&
        o.start >= n.startIndex &&
        o.start < n.endIndex &&
        !(o.start >= inner.startIndex && o.start < inner.endIndex)
    )
  let outer = core
  for (let p = outer.parent; p && isWrapper(profile, p) && !holdsOther(p, outer); p = outer.parent) outer = p

  const trivia = (n: SyntaxNode) => profile.comments.has(n.type) || profile.decorators.has(n.type)
  let decoratorStart: number | undefined
  let headStart = outer.startIndex
  for (const child of outer.children) {
    if (!trivia(child)) {
      headStart = child.startIndex
      break
    }
    if (profile.decorators.has(child.type)) decoratorStart ??= child.startIndex
  }

  // Comments and decorators directly above, each starting its line; above those,
  // any overload signatures and their comments. A blank line detaches a comment
  // (a section header), never a decorator or overload: those belong to what follows.
  let triviaStart = outer.startIndex
  let below = outer.startIndex
  let overloaded = false
  for (let sib = siblingAbove(outer); sib; sib = sib.previousNamedSibling) {
    const overload = profile.overload?.(sib, name) ?? false
    const gap = text.slice(sib.endIndex, below)
    // A decorator may share its line with the decorators before it (`@A() @B()`).
    const prev = sib.previousNamedSibling
    const afterDecorator =
      profile.decorators.has(sib.type) &&
      prev !== null &&
      profile.decorators.has(prev.type) &&
      /^[ \t]*$/.test(text.slice(prev.endIndex, sib.startIndex))
    if (
      !(overload || trivia(sib)) ||
      gap.trim() ||
      (profile.comments.has(sib.type) && /\n[ \t]*\n/.test(gap)) ||
      !(startsLine(text, sib.startIndex) || afterDecorator) ||
      FILE_COMMENT.test(sib.text)
    )
      break
    below = sib.startIndex
    overloaded ||= overload
    if (overloaded) continue
    triviaStart = below
    if (profile.decorators.has(sib.type)) decoratorStart = below
  }

  const valueHeld = profile.values?.has(core.type) && core.parent?.type === 'variable_declarator'
  return {
    end: codeEnd(outer, profile.comments, text),
    ...(overloaded ? { overloadStart: below } : {}),
    triviaStart,
    ...(decoratorStart !== undefined ? { decoratorStart } : {}),
    headStart,
    exportPrefix: profile.exportPrefix?.(outer, headStart, text),
    ...(valueHeld ? { value: { start: core.startIndex, end: codeEnd(core, profile.comments, text) } } : {})
  }
}

/**
 * The named sibling above `node`. A Python block starts at its first statement
 * and keeps the comments above that statement outside itself, so when a node
 * opens its parent, look above the parent.
 */
function siblingAbove(node: SyntaxNode): SyntaxNode | null {
  let n = node
  while (!n.previousNamedSibling && n.parent && n.parent.startIndex === n.startIndex) n = n.parent
  return n.previousNamedSibling
}

/**
 * Where a declaration's code ends. Grammars tuck a same-line trailing comment
 * into the node (`} // done`, `const x = 1 // why`). It stays outside when it
 * follows a closing bracket or a one-line declaration; after the last
 * statement of a body (`    return 1  # one`) it belongs to that statement.
 */
function codeEnd(node: SyntaxNode, comments: ReadonlySet<string>, text: string): number {
  const end = lastToken(node, comments)
  const code = text.slice(node.startIndex, end)
  return /[}\])];?$/.test(code) || !code.includes('\n') ? end : node.endIndex
}

function lastToken(node: SyntaxNode, comments: ReadonlySet<string>): number {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i]
    if (!comments.has(child.type)) return child.children.length ? lastToken(child, comments) : child.endIndex
  }
  return node.endIndex
}

function isWrapper(profile: LanguageProfile, node: SyntaxNode): boolean {
  if (!profile.wrappers.has(node.type)) return false
  const only = profile.single?.[node.type]
  return !only || node.namedChildren.filter((c) => only.includes(c.type)).length === 1
}

function firstError(node: SyntaxNode): SyntaxProblem | undefined {
  if (node.isMissing || node.type === 'ERROR') {
    return {
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      message: node.isMissing ? `missing '${node.type}'` : 'syntax error'
    }
  }
  for (const child of node.children) {
    if (child.hasError || child.isMissing) {
      const found = firstError(child)
      if (found) return found
    }
  }
  return undefined
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** 1-based line holding `offset`. */
function upperBound(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}
