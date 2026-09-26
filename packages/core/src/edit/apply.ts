// Applies edit ops to a file's text. Pure: the analyzer supplies declarations
// and syntax verdicts; nothing here touches the filesystem.
//
// Every op resolves its symbol against the text as it stands after the ops
// before it, and the text is re-analysed after each op. An op that breaks a
// file which parsed before fails the whole call.

import { resolveSymbol } from './resolve.js'
import {
  AnchorError,
  declarationHead,
  findAnchor,
  indentAt,
  indentBlock,
  leadingElement,
  lineEnd,
  lineOf,
  lineStart,
  reindent,
  startsLine
} from './text.js'
import { EditError, type Analysis, type Analyzer, type Declaration, type EditOp } from './types.js'

export interface SignatureChange {
  qualifiedName: string
  before?: string
  after?: string
  /** Set when the op renamed the declaration. */
  renamedTo?: string
}

export interface EditOutcome {
  text: string
  /** One line per op, then warnings. */
  notes: string[]
  signatureChanges: SignatureChange[]
  analysis: Analysis
  /** False when no grammar covers the file, or it had a syntax error before the edit. */
  syntaxChecked: boolean
}

export interface ApplyOptions {
  /** How messages name the file. */
  label: string
  /** False when the file does not exist yet; then the first op must be `create`. */
  exists: boolean
}

interface Step {
  text: string
  note: (after: string) => string
  /** Checks the re-analysed text; may throw or return a note. */
  verify?: (next: Analysis) => string | undefined
  change?: (next: Analysis) => SignatureChange | undefined
}

const SHOW_LINES = 60

export function applyOps(
  path: string,
  text: string,
  ops: EditOp[],
  analyzer: Analyzer,
  opts: ApplyOptions
): EditOutcome {
  if (ops.length === 0) throw new EditError('No ops given.')
  ops.slice(1).forEach((op) => {
    if (op.op === 'create') throw new EditError('create must be the first op.')
  })
  const creating = ops[0].op === 'create'
  if (creating && opts.exists) throw new EditError(`${opts.label} already exists; create only makes new files.`)
  if (!creating && !opts.exists) throw new EditError(`${opts.label} does not exist. Use a create op to make it.`)

  let cur = creating ? reindent((ops[0] as { code: string }).code, '') + '\n' : text
  let analysis = analyzer.analyze(path, cur)
  const notes: string[] = []
  const warnings: string[] = []
  const changes: SignatureChange[] = []
  if (creating) {
    if (analysis.syntaxError) throw new EditError(`create: ${syntaxMessage(analysis, cur)}`)
    notes.push(`create · ${lineOf(cur, cur.length - 1)} lines`)
  }
  const gate = analysis.checked && !analysis.syntaxError
  if (!analysis.checked) warnings.push('No grammar for this file type: syntax not checked.')
  else if (analysis.syntaxError) {
    const e = analysis.syntaxError
    warnings.push(`The file already had a syntax error (line ${e.line}:${e.column}): syntax not checked.`)
  }

  ops.slice(creating ? 1 : 0).forEach((op, i) => {
    const tag = ops.length > 1 ? `op ${i + (creating ? 2 : 1)} (${op.op})` : op.op
    let step: Step
    try {
      step = applyOne(op, cur, analysis, opts.label)
    } catch (err) {
      throw err instanceof EditError ? new EditError(`${tag}: ${err.message}`) : err
    }
    const next = analyzer.analyze(path, step.text)
    if (gate && next.syntaxError) {
      throw new EditError(`${tag} breaks the syntax: ${syntaxMessage(next, step.text)}`)
    }
    let warning: string | undefined
    try {
      warning = step.verify?.(next)
    } catch (err) {
      throw err instanceof EditError ? new EditError(`${tag}: ${err.message}`) : err
    }
    if (warning) warnings.push(warning)
    const change = step.change?.(next)
    if (change) changes.push(change)
    notes.push(step.note(step.text))
    cur = step.text
    analysis = next
  })

  return { text: cur, notes: [...notes, ...warnings], signatureChanges: changes, analysis, syntaxChecked: gate }
}

function applyOne(op: EditOp, text: string, analysis: Analysis, label: string): Step {
  switch (op.op) {
    case 'replace':
      return replace(op.symbol, op.code, text, analysis, label)
    case 'replace_in':
      return replaceIn(op, text, analysis, label)
    case 'insert':
      return insert(op, text, analysis, label)
    case 'remove':
      return remove(op.symbol, text, analysis, label)
    case 'create':
      throw new EditError('create must be the first op.')
    default:
      throw new EditError(`Unknown op '${(op as { op: string }).op}'.`)
  }
}

// ── replace ───────────────────────────────────────────────────────────────────

function replace(symbol: string, code: string, text: string, analysis: Analysis, label: string): Step {
  const d = lookup(analysis, symbol, label)
  const { traits } = analysis
  const lead = leadingElement(code, traits)
  const head = code.slice(declarationHead(code, traits)).trimStart()

  // How far back the code reaches decides what it replaces: comments first,
  // then decorators, then the declaration; for a function or class held in a
  // variable, code that does not restate the statement replaces only the value.
  let start = d.headStart
  let end = d.end
  const valueOnly = lead === 'code' && d.value !== undefined && !traits.statement?.test(head)
  if (lead === 'comment') start = d.triviaStart
  else if (lead === 'decorator') start = d.decoratorStart ?? d.headStart
  else if (valueOnly) ({ start, end } = d.value!)

  let body = reindent(code, indentAt(text, start))
  let kept: string | undefined
  if (!valueOnly && d.exportPrefix && !traits.exported?.test(head) && traits.declaration?.test(head)) {
    const at = declarationHead(body, traits)
    body = body.slice(0, at) + d.exportPrefix + body.slice(at)
    kept = d.exportPrefix.trim()
  }
  const next = text.slice(0, start) + body + text.slice(end)
  const lo = start
  const hi = start + body.length

  const occupant = (after: Analysis) => {
    const inside = after.declarations.filter(
      (x) => within(x.headStart, lo, hi) || (x.value && within(x.value.start, lo, hi))
    )
    return (
      inside.find((x) => x.qualifiedName === d.qualifiedName) ?? inside.sort((a, b) => a.headStart - b.headStart)[0]
    )
  }
  return {
    text: next,
    note: (after) =>
      `replace ${d.qualifiedName}${valueOnly ? ' (value)' : ''} · lines ${d.startLine}–${d.endLine} → ${lineOf(after, lo)}–${lineOf(after, hi)}`,
    verify: (after) => {
      const o = occupant(after)
      if (!o) {
        throw new EditError(
          `the code holds no declaration where '${d.qualifiedName}' was. replace swaps whole declarations; use replace_in to change part of one.`
        )
      }
      const notes = [
        kept && `kept '${kept}' (the code omitted it; use replace_in to drop it)`,
        o.qualifiedName !== d.qualifiedName &&
          `renamed ${d.qualifiedName} → ${o.qualifiedName}; references are not updated`
      ].filter(Boolean)
      return notes.length ? notes.join('; ') : undefined
    },
    change: (after) => signatureChange(d, occupant(after))
  }
}

// ── replace_in ────────────────────────────────────────────────────────────────

function replaceIn(op: Extract<EditOp, { op: 'replace_in' }>, text: string, analysis: Analysis, label: string): Step {
  const d = op.symbol ? lookup(analysis, op.symbol, label) : undefined
  // Search from the start of the declaration's line, so indentation-insensitive
  // matching sees the first line's real indent.
  const hayStart = d ? (startsLine(text, d.triviaStart) ? lineStart(text, d.triviaStart) : d.triviaStart) : 0
  const hay = text.slice(hayStart, d ? d.end : text.length)
  const where = d ? `'${d.qualifiedName}'` : label

  const first = anchor(hay, op.find, 'find', where, d, text, hayStart)
  let endRel = first.end
  let exact = first.exact
  if (op.to !== undefined) {
    const second = anchor(hay.slice(first.end), op.to, 'to', `${where} after find`, d, text, hayStart)
    endRel = first.end + second.end
    exact = exact && second.exact
  }
  const start = hayStart + first.start
  const end = hayStart + endRel
  const body = exact ? op.code.replace(/\r\n/g, '\n') : reindent(op.code, indentAt(text, start))
  const next = text.slice(0, start) + body + text.slice(end)
  const oldLines = text.slice(start, end).split('\n').length
  const newLines = body.split('\n').length

  // The declaration now around the edit: the same name, or a same-kind sibling (a rename).
  const parent = d ? containerOf(d.qualifiedName) : ''
  const owner = (after: Analysis) => {
    if (!d) return undefined
    const around = after.declarations.filter((x) => x.triviaStart <= start && start <= x.end)
    return (
      around.find((x) => x.qualifiedName === d.qualifiedName) ??
      around.find((x) => x.kind === d.kind && containerOf(x.qualifiedName) === parent)
    )
  }
  return {
    text: next,
    note: (after) =>
      `replace_in ${d ? d.qualifiedName : 'file'} · line ${lineOf(after, start)}: ${oldLines} → ${newLines} line${newLines === 1 ? '' : 's'}${exact ? '' : ' (matched ignoring indentation)'}`,
    verify: (after) => {
      if (!d) return undefined
      const o = owner(after)
      if (!o) {
        throw new EditError(
          `the change leaves no declaration '${d.qualifiedName}' around the edit. Use replace for whole declarations, or remove.`
        )
      }
      return o.qualifiedName !== d.qualifiedName
        ? `renamed ${d.qualifiedName} → ${o.qualifiedName}; references are not updated`
        : undefined
    },
    change: (after) => (d ? signatureChange(d, owner(after)) : undefined)
  }
}

function anchor(
  hay: string,
  needle: string,
  field: 'find' | 'to',
  where: string,
  d: Declaration | undefined,
  text: string,
  hayStart: number
) {
  try {
    return findAnchor(hay, needle)
  } catch (err) {
    if (!(err instanceof AnchorError)) throw err
    if (err.reason === 'many') {
      const lines = err.hits.map((h) => lineOf(text, hayStart + h)).join(', ')
      throw new EditError(
        `${field} matches ${err.hits.length} places in ${where} (lines ${lines}). Add surrounding text to make it unique.`
      )
    }
    if (!d) throw new EditError(`${field} matches nothing in ${where}.`)
    throw new EditError(
      `${field} matches nothing in ${where}. Its current text:\n${numbered(text, d.triviaStart, d.end)}`
    )
  }
}

// ── insert ────────────────────────────────────────────────────────────────────

function insert(op: Extract<EditOp, { op: 'insert' }>, text: string, analysis: Analysis, label: string): Step {
  if (op.after !== undefined && op.before !== undefined) throw new EditError('give after or before, not both.')
  const anchorName = op.after ?? op.before
  if (anchorName === undefined) {
    const body = reindent(op.code, '')
    const trimmed = text.replace(/\n+$/, '')
    const at = trimmed.length ? trimmed.length + 2 : 0
    const next = (trimmed.length ? trimmed + '\n\n' : '') + body + (text.endsWith('\n') || !text ? '\n' : '')
    return {
      text: next,
      note: (after) => `insert at end of file · lines ${lineOf(after, at)}–${lineOf(after, at + body.length)}`
    }
  }

  const d = lookup(analysis, anchorName, label)
  if (!startsLine(text, d.triviaStart)) {
    throw new EditError(
      `'${d.qualifiedName}' shares line ${d.line} with other code; insert needs a symbol on its own lines. Use replace_in instead.`
    )
  }
  const block = indentBlock(op.code, indentAt(text, d.triviaStart))
  let at: number
  let next: string
  if (op.after !== undefined) {
    const eol = lineEnd(text, d.end)
    if (!/^\s*(?:(?:\/\/|#).*)?$/.test(text.slice(d.end, eol))) {
      throw new EditError(
        `'${d.qualifiedName}' ends mid-line (line ${d.endLine}); insert after it is ambiguous. Use replace_in instead.`
      )
    }
    const following = eol < text.length ? text.slice(eol + 1, lineEnd(text, eol + 1)) : ''
    const gap = following.trim() && !/^\s*[}\])]/.test(following) ? '\n' : ''
    at = eol + 2
    next = text.slice(0, eol) + '\n\n' + block + gap + text.slice(eol)
  } else {
    const sol = lineStart(text, d.triviaStart)
    const preceding = sol > 0 ? text.slice(lineStart(text, sol - 1), sol - 1) : ''
    const gap = preceding.trim() && !/[{([:]\s*$/.test(preceding) ? '\n' : ''
    at = sol + gap.length
    next = text.slice(0, sol) + gap + block + '\n\n' + text.slice(sol)
  }
  return {
    text: next,
    note: (after) =>
      `insert ${op.after !== undefined ? 'after' : 'before'} ${d.qualifiedName} · lines ${lineOf(after, at)}–${lineOf(after, at + block.length)}`
  }
}

// ── remove ────────────────────────────────────────────────────────────────────

function remove(symbol: string, text: string, analysis: Analysis, label: string): Step {
  const d = lookup(analysis, symbol, label)
  const eol = lineEnd(text, d.end)
  const ownLines = startsLine(text, d.triviaStart) && /^\s*(?:(?:\/\/|#).*)?$/.test(text.slice(d.end, eol))
  let next: string
  if (ownLines) {
    const from = lineStart(text, d.triviaStart)
    const to = eol < text.length ? eol + 1 : eol
    next = tidyBlankLines(text.slice(0, from) + text.slice(to), from)
  } else {
    // Mid-line (an enum member, a type literal member): take one list separator with it.
    let from = d.triviaStart
    let to = d.end
    const after = /^[ \t]*[,;][ \t]*/.exec(text.slice(to))
    if (after) to += after[0].length
    else {
      const before = /[ \t]*,[ \t]*$/.exec(text.slice(lineStart(text, from), from))
      if (before) from -= before[0].length
    }
    next = text.slice(0, from) + text.slice(to)
  }
  return { text: next, note: () => `remove ${d.qualifiedName} · lines ${d.startLine}–${d.endLine}` }
}

/** After deleting whole lines at `at`, drop the blank line the deletion leaves doubled or dangling. */
function tidyBlankLines(text: string, at: number): string {
  const prevStart = at > 0 ? lineStart(text, at - 1) : -1
  const prev = prevStart >= 0 ? text.slice(prevStart, at - 1) : undefined
  const next = text.slice(at, lineEnd(text, at))
  const nextBlank = at >= text.length || !next.trim()
  if (prev !== undefined && !prev.trim() && (nextBlank || /^\s*[}\])]/.test(next))) {
    return text.slice(0, prevStart) + text.slice(at)
  }
  if (at < text.length && !next.trim() && (prev === undefined || /[{([:]\s*$/.test(prev))) {
    return text.slice(0, at) + text.slice(Math.min(text.length, lineEnd(text, at) + 1))
  }
  return text
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A file that does not parse yields no symbols; say why instead of listing none. */
function lookup(analysis: Analysis, symbol: string, label: string): Declaration {
  const e = analysis.syntaxError
  if (e && analysis.declarations.length === 0) {
    throw new EditError(
      `${label} has a syntax error at line ${e.line}:${e.column + 1}, so no symbol resolves. Fix it first: replace_in without a symbol still works.`
    )
  }
  return resolveSymbol(analysis.declarations, symbol, label)
}

function containerOf(qualifiedName: string): string {
  return qualifiedName.split('::').slice(0, -1).join('::')
}

function within(offset: number, lo: number, hi: number): boolean {
  return offset >= lo && offset < hi
}

function signatureChange(before: Declaration, after: Declaration | undefined): SignatureChange | undefined {
  if (!after) return undefined
  const renamed = after.qualifiedName !== before.qualifiedName
  if (!renamed && (before.signature ?? '') === (after.signature ?? '')) return undefined
  return {
    qualifiedName: before.qualifiedName,
    before: before.signature,
    after: after.signature,
    ...(renamed ? { renamedTo: after.qualifiedName } : {})
  }
}

function syntaxMessage(analysis: Analysis, text: string): string {
  const e = analysis.syntaxError!
  const lineText = text.split('\n')[e.line - 1] ?? ''
  return `${e.message} at line ${e.line}:${e.column + 1}\n  ${e.line} | ${lineText}\n  ${' '.repeat(String(e.line).length)} | ${' '.repeat(e.column)}^`
}

/** The text between two offsets with 1-based line numbers, capped. */
function numbered(text: string, from: number, to: number): string {
  const first = lineOf(text, from)
  const lines = text.slice(lineStart(text, from), lineEnd(text, to)).split('\n')
  const width = String(first + lines.length - 1).length
  const shown = lines.slice(0, SHOW_LINES).map((l, i) => `${String(first + i).padStart(width)} | ${l}`)
  if (lines.length > SHOW_LINES) shown.push(`… ${lines.length - SHOW_LINES} more lines`)
  return shown.join('\n')
}
