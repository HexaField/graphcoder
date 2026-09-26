// Text helpers for the edit engine. All offsets index LF-normalised text.

/** A source file split into its edit form (no BOM, LF endings) plus what restores it. */
export interface NormalisedSource {
  text: string
  bom: boolean
  crlf: boolean
}

export function normaliseSource(raw: string): NormalisedSource {
  const bom = raw.charCodeAt(0) === 0xfeff
  const body = bom ? raw.slice(1) : raw
  const crlfCount = body.match(/\r\n/g)?.length ?? 0
  const crlf = crlfCount > (body.match(/\n/g)?.length ?? 0) - crlfCount
  return { text: body.replace(/\r\n/g, '\n'), bom, crlf }
}

export function restoreSource(text: string, source: Pick<NormalisedSource, 'bom' | 'crlf'>): string {
  const body = source.crlf ? text.replace(/\n/g, '\r\n') : text
  return source.bom ? '﻿' + body : body
}

export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

/** Offset of the newline that ends the line holding `offset`, or text.length. */
export function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset)
  return nl === -1 ? text.length : nl
}

/** 1-based line number of `offset`. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** Offset of a 1-based line and 0-based column. */
export function offsetOf(text: string, line: number, column: number): number {
  let pos = 0
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return text.length
    pos = nl + 1
  }
  return Math.min(pos + column, text.length)
}

/** Leading whitespace of the line holding `offset`. */
export function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset)
  return /^[ \t]*/.exec(text.slice(start, lineEnd(text, start)))![0]
}

/** True when only spaces and tabs sit between the start of its line and `offset`. */
export function startsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset))
}

/**
 * Re-base a code snippet onto `indent`. The first line is returned bare — it
 * lands where the old text began — and every later non-blank line gets
 * `indent` plus its indentation relative to the snippet's own base.
 */
export function reindent(code: string, indent: string): string {
  const lines = trimBlankEdges(code.replace(/\r\n/g, '\n')).split('\n')
  const base = snippetBase(lines)
  return lines
    .map((line, i) => {
      if (!line.trim()) return ''
      const own = i === 0 ? line.trimStart() : line.startsWith(base) ? line.slice(base.length) : line.trimStart()
      return i === 0 ? own : indent + own
    })
    .join('\n')
}

/** The same snippet, indented as a whole block (first line included). */
export function indentBlock(code: string, indent: string): string {
  return indent + reindent(code, indent)
}

function trimBlankEdges(code: string): string {
  return code
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '')
    .replace(/\s+$/, '')
}

/**
 * Indentation shared by a snippet's lines. Agents often paste code copied
 * from inside a block with the first line's indent stripped; when the first
 * line has none but the closing bracket does, that bracket's indent is the base.
 */
function snippetBase(lines: string[]): string {
  const nonBlank = lines.filter((l) => l.trim())
  const common = commonIndent(nonBlank)
  const closing = nonBlank[nonBlank.length - 1]
  if (common || nonBlank.length < 2 || /^[ \t]/.test(nonBlank[0]) || !/^[ \t]+[}\])]/.test(closing)) return common
  const last = /^[ \t]*/.exec(closing)![0]
  return nonBlank.slice(1).every((l) => l.startsWith(last)) ? last : ''
}

function commonIndent(lines: string[]): string {
  let prefix: string | null = null
  for (const line of lines) {
    const ws = /^[ \t]*/.exec(line)![0]
    if (prefix === null) prefix = ws
    else {
      let i = 0
      while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i++
      prefix = prefix.slice(0, i)
    }
    if (!prefix) return ''
  }
  return prefix ?? ''
}

// ── Anchor matching ───────────────────────────────────────────────────────────

export interface AnchorHit {
  start: number
  end: number
  /** False when the match ignored indentation or surrounding whitespace. */
  exact: boolean
}

export class AnchorError extends Error {
  readonly reason: 'none' | 'many'
  /** Offsets (into the haystack) of each hit, when there were several. */
  readonly hits: number[]

  constructor(reason: 'none' | 'many', hits: number[] = []) {
    super(reason === 'none' ? 'no match' : `${hits.length} matches`)
    this.reason = reason
    this.hits = hits
  }
}

/**
 * Find `needle` in `hay` exactly once. Passes, first unique hit wins: exact
 * text; then indentation-insensitive (whole lines, any common indent, trailing
 * spaces ignored); then per-line whitespace-insensitive. Several hits in a
 * pass is an error, never a guess.
 */
export function findAnchor(hay: string, needle: string): AnchorHit {
  const n = needle.replace(/\r\n/g, '\n')
  if (!n.trim()) throw new AnchorError('none')
  const passes: Array<() => AnchorHit[]> = [
    () => substringHits(hay, n).map((start) => ({ start, end: start + n.length, exact: true })),
    () => (n.includes('\n') ? windowHits(hay, n, dedentedLines) : trimmedHits(hay, n)),
    () => (n.includes('\n') ? windowHits(hay, n, (lines) => lines.map((l) => l.trim())) : [])
  ]
  for (const pass of passes) {
    const hits = pass()
    if (hits.length === 1) return hits[0]
    if (hits.length > 1)
      throw new AnchorError(
        'many',
        hits.map((h) => h.start)
      )
  }
  throw new AnchorError('none')
}

function substringHits(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

function trimmedHits(hay: string, needle: string): AnchorHit[] {
  const t = needle.trim()
  return t === needle ? [] : substringHits(hay, t).map((start) => ({ start, end: start + t.length, exact: false }))
}

function dedentedLines(lines: string[]): string[] {
  const base = commonIndent(lines.filter((l) => l.trim()))
  return lines.map((l) => (l.trim() ? l.slice(base.length).trimEnd() : ''))
}

/** Whole-line windows of `hay` whose lines equal the needle's under `norm`. */
function windowHits(hay: string, needle: string, norm: (lines: string[]) => string[]): AnchorHit[] {
  const want = norm(trimBlankEdges(needle).split('\n')).join('\n')
  const count = want.split('\n').length
  const starts = [0]
  for (let i = hay.indexOf('\n'); i !== -1; i = hay.indexOf('\n', i + 1)) starts.push(i + 1)
  const lines = hay.split('\n')
  const hits: AnchorHit[] = []
  for (let i = 0; i + count <= lines.length; i++) {
    if (norm(lines.slice(i, i + count)).join('\n') !== want) continue
    const first = lines[i]
    const last = lines[i + count - 1]
    const start = starts[i] + (first.length - first.trimStart().length)
    hits.push({ start, end: starts[i + count - 1] + last.trimEnd().length, exact: false })
  }
  return hits
}

// ── Leading comments and decorators in replacement code ──────────────────────

export interface CodeTraits {
  /** Tokens that open a comment: ['//', '/*'] or ['#']. */
  comment: string[]
  /** Tokens that open a decorator or attribute: ['@'] or ['#[']. */
  decorator: string[]
}

/** What a snippet opens with, which decides how much of the old declaration it replaces. */
export function leadingElement(code: string, traits: CodeTraits): 'comment' | 'decorator' | 'code' {
  const head = code.trimStart()
  if (traits.decorator.some((t) => head.startsWith(t))) return 'decorator'
  if (traits.comment.some((t) => head.startsWith(t))) return 'comment'
  return 'code'
}

/** Offset in `code` where the declaration begins, past leading comments and decorators. */
export function declarationHead(code: string, traits: CodeTraits): number {
  let i = 0
  for (;;) {
    while (i < code.length && /\s/.test(code[i])) i++
    const rest = code.slice(i)
    const deco = traits.decorator.find((t) => rest.startsWith(t))
    if (deco) {
      i = skipDecorator(code, i + deco.length, deco === '#[')
      continue
    }
    const comment = traits.comment.find((t) => rest.startsWith(t))
    if (!comment) return i
    if (comment === '/*') {
      const close = code.indexOf('*/', i + 2)
      i = close === -1 ? code.length : close + 2
    } else {
      i = lineEnd(code, i)
    }
  }
}

/** Past a decorator body: a dotted name plus balanced brackets, or up to `]` for Rust attributes. */
function skipDecorator(code: string, i: number, bracketed: boolean): number {
  let depth = bracketed ? 1 : 0
  while (i < code.length) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0 && bracketed) return i + 1
    } else if (depth === 0 && /\s/.test(c)) return i
    i++
  }
  return i
}
