// Per-language knowledge the analyzer needs to turn a codegraph symbol into
// a whole declaration: which tree-sitter nodes wrap a declaration without
// being a container, what sits attached above one, and what counts as
// visibility that replacement code keeps.

import { createRequire } from 'node:module'
import { extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { LanguageTraits, SyntaxProblem } from '../types.js'

const require = createRequire(import.meta.url)

/** The slice of a tree-sitter node the analyzer reads. */
export interface SyntaxNode {
  type: string
  text: string
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  hasError: boolean
  isMissing: boolean
  parent: SyntaxNode | null
  children: SyntaxNode[]
  namedChildren: SyntaxNode[]
  previousNamedSibling: SyntaxNode | null
  childForFieldName(name: string): SyntaxNode | null
  namedDescendantForIndex(start: number, end: number): SyntaxNode
}

export interface LanguageProfile {
  id: string
  grammar: () => unknown
  /** A stricter syntax check than the grammar's: a problem, null when clean, undefined when unavailable. */
  validate?: (text: string) => SyntaxProblem | null | undefined
  traits: LanguageTraits
  /** Node types that wrap a declaration without being a container. */
  wrappers: ReadonlySet<string>
  /** Wrappers that count only while they hold one child of these types (`const a = 1, b = 2`). */
  single?: Readonly<Record<string, readonly string[]>>
  /** Sibling types that attach above a declaration: comments, decorators, attributes. */
  trivia: ReadonlySet<string>
  decorators: ReadonlySet<string>
  /** Value node types: a function or class assigned to a variable. */
  values?: ReadonlySet<string>
  /** Visibility text replacement code keeps when it omits it. */
  exportPrefix?: (outer: SyntaxNode, headStart: number, text: string) => string | undefined
}

const TS_TRAITS: LanguageTraits = {
  comment: ['//', '/*'],
  decorator: ['@'],
  exported: /^export\b/,
  statement: /^(?:export|declare|const|let|var)\b/,
  declaration:
    /^(?:(?:async\s+)?function\b|(?:abstract\s+)?class\b|(?:interface|type|enum|const|let|var|namespace|module|declare|default)\b)/
}

function tsProfile(id: string, grammar: () => unknown): LanguageProfile {
  return {
    id,
    grammar,
    traits: TS_TRAITS,
    wrappers: new Set([
      'export_statement',
      'ambient_declaration',
      'lexical_declaration',
      'variable_declaration',
      'variable_declarator',
      'expression_statement',
      'enum_assignment'
    ]),
    single: { lexical_declaration: ['variable_declarator'], variable_declaration: ['variable_declarator'] },
    trivia: new Set(['comment', 'decorator']),
    decorators: new Set(['decorator']),
    values: new Set(['arrow_function', 'function_expression', 'function', 'generator_function', 'class']),
    exportPrefix: (outer, headStart, text) => {
      if (outer.type !== 'export_statement') return undefined
      const inner = outer.childForFieldName('declaration') ?? outer.childForFieldName('value')
      return inner ? text.slice(headStart, inner.startIndex).replace(/\s+/g, ' ') : undefined
    }
  }
}

const typescript = tsProfile('typescript', () => require('tree-sitter-typescript').typescript)
// The TSX grammar also parses plain JavaScript and JSX.
const tsx = tsProfile('tsx', () => require('tree-sitter-typescript').tsx)

// tree-sitter-python accepts bad indentation (a def with no indented body,
// an unindent to no outer level); CPython's parser does not.
const PY_CHECK = [
  'import ast, sys',
  'try:',
  '    ast.parse(sys.stdin.read())',
  'except SyntaxError as e:',
  '    print(f"{e.lineno}:{e.offset or 1}:{type(e).__name__}: {e.msg}")'
].join('\n')
let pythonAvailable = true

function pythonSyntax(text: string): SyntaxProblem | null | undefined {
  if (!pythonAvailable) return undefined
  const r = spawnSync('python3', ['-c', PY_CHECK], { input: text, encoding: 'utf8', timeout: 10_000 })
  if (r.error || r.status !== 0) {
    pythonAvailable = r.error === undefined
    return undefined
  }
  const m = /^(\d+):(\d+):(.*)$/.exec(r.stdout.trim())
  return m ? { line: Number(m[1]), column: Number(m[2]) - 1, message: m[3] } : null
}

const python: LanguageProfile = {
  id: 'python',
  grammar: () => require('tree-sitter-python'),
  validate: pythonSyntax,
  traits: { comment: ['#'], decorator: ['@'] },
  wrappers: new Set(['decorated_definition', 'expression_statement']),
  trivia: new Set(['comment']),
  decorators: new Set(['decorator'])
}

const rust: LanguageProfile = {
  id: 'rust',
  grammar: () => require('tree-sitter-rust'),
  traits: {
    comment: ['//', '/*'],
    decorator: ['#['],
    exported: /^pub\b/,
    declaration:
      /^(?:(?:async|const|unsafe|extern(?:\s+"[^"]*")?)\s+)*(?:fn|struct|enum|trait|impl|type|const|static|mod|union|macro_rules!)\b/
  },
  wrappers: new Set(['const_item', 'static_item', 'enum_variant']),
  trivia: new Set(['line_comment', 'block_comment', 'attribute_item']),
  decorators: new Set(['attribute_item']),
  exportPrefix: (outer) => {
    const vis = outer.namedChildren.find((c) => c.type === 'visibility_modifier')
    return vis ? `${vis.text} ` : undefined
  }
}

const go: LanguageProfile = {
  id: 'go',
  grammar: () => require('tree-sitter-go'),
  traits: { comment: ['//', '/*'], decorator: [] },
  wrappers: new Set(['type_declaration', 'var_declaration', 'const_declaration']),
  single: {
    type_declaration: ['type_spec', 'type_alias'],
    var_declaration: ['var_spec'],
    const_declaration: ['const_spec']
  },
  trivia: new Set(['comment']),
  decorators: new Set()
}

const BY_EXTENSION: Record<string, LanguageProfile> = {
  '.ts': typescript,
  '.mts': typescript,
  '.cts': typescript,
  '.tsx': tsx,
  '.js': tsx,
  '.jsx': tsx,
  '.mjs': tsx,
  '.cjs': tsx,
  '.py': python,
  '.pyi': python,
  '.rs': rust,
  '.go': go
}

/** Traits for files no grammar covers: every common comment and decorator token. */
export const GENERIC_TRAITS: LanguageTraits = { comment: ['//', '/*', '#'], decorator: ['@'] }

export function profileFor(path: string): LanguageProfile | undefined {
  return BY_EXTENSION[extname(path).toLowerCase()]
}
