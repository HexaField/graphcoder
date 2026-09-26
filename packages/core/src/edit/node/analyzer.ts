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
        ? widen(root, profile, text, spans, i)
        : { ...spans[i], triviaStart: spans[i].start, headStart: spans[i].start }
    const end = region.end
    return {
      name: n.name,
      qualifiedName: n.qualifiedName,
      kind: n.kind,
      ...(n.signature ? { signature: n.signature } : {}),
      triviaStart: region.triviaStart,
      ...(region.decoratorStart !== undefined ? { decoratorStart: region.decoratorStart } : {}),
      headStart: region.headStart,
      ...(region.exportPrefix ? { exportPrefix: region.exportPrefix } : {}),
      ...(region.value ? { value: region.value } : {}),
      end,
      startLine: lineAt(region.triviaStart),
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
  start: number
  end: number
  triviaStart: number
  decoratorStart?: number
  headStart: number
  exportPrefix?: string
  value?: { start: number; end: number }
}

function widen(
  root: SyntaxNode,
  profile: LanguageProfile,
  text: string,
  spans: Array<{ start: number; end: number }>,
  i: number
): Region {
  const { start: s, end: e } = spans[i]
  let core = root.namedDescendantForIndex(s, Math.max(s, e - 1))
  while (core.parent && (core.startIndex > s || core.endIndex < e)) core = core.parent
  // codegraph and the grammar disagree about this symbol: trust codegraph's span.
  if (core === root || !core.parent) return { start: s, end: e, triviaStart: s, headStart: s }

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

  let decoratorStart: number | undefined
  let headStart = outer.startIndex
  for (const child of outer.children) {
    if (!profile.decorators.has(child.type)) {
      headStart = child.startIndex
      break
    }
    decoratorStart ??= child.startIndex
  }

  // Comments and decorators directly above, each on its own line, no blank line between.
  let triviaStart = outer.startIndex
  let below = outer.startIndex
  for (let sib = outer.previousNamedSibling; sib && profile.trivia.has(sib.type); sib = sib.previousNamedSibling) {
    const gap = text.slice(sib.endIndex, below)
    if (
      gap.trim() ||
      /\n[ \t]*\n/.test(gap) ||
      !/^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', sib.startIndex - 1) + 1, sib.startIndex))
    )
      break
    triviaStart = below = sib.startIndex
    if (profile.decorators.has(sib.type)) decoratorStart = sib.startIndex
  }

  const valueHeld = profile.values?.has(core.type) && core.parent?.type === 'variable_declarator'
  return {
    start: outer.startIndex,
    end: outer.endIndex,
    triviaStart,
    ...(decoratorStart !== undefined ? { decoratorStart } : {}),
    headStart,
    exportPrefix: profile.exportPrefix?.(outer, headStart, text),
    ...(valueHeld ? { value: { start: core.startIndex, end: core.endIndex } } : {})
  }
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
