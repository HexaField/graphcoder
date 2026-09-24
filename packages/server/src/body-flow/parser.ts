import { createRequire } from 'node:module'
import { extname } from 'node:path'

const require = createRequire(import.meta.url)

export interface SyntaxNode {
  id: number
  type: string
  text: string
  /** Offset into the parsed JS string (UTF-16 code units) */
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  namedChildren: SyntaxNode[]
  children: SyntaxNode[]
  parent: SyntaxNode | null
  childForFieldName(name: string): SyntaxNode | null
  childrenForFieldName(name: string): SyntaxNode[]
}

interface ParseTree {
  rootNode: SyntaxNode
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust'
}

/** Body-flow language for a source path, or null when unsupported. */
export function languageForPath(filePath: string): string | null {
  return LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()] ?? null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadLanguage(langId: string): any {
  const cached = languageCache.get(langId)
  if (cached) return cached

  let grammar
  switch (langId) {
    case 'typescript':
      grammar = require('tree-sitter-typescript').typescript
      break
    // The TSX grammar parses plain JS as well as JSX
    case 'tsx':
    case 'javascript':
    case 'jsx':
      grammar = require('tree-sitter-typescript').tsx
      break
    case 'python':
      grammar = require('tree-sitter-python')
      break
    case 'go':
      grammar = require('tree-sitter-go')
      break
    case 'rust':
      grammar = require('tree-sitter-rust')
      break
    default:
      return null
  }

  languageCache.set(langId, grammar)
  return grammar
}

export function parseSource(source: string, language: string): ParseTree | null {
  const lang = loadLanguage(language)
  if (!lang) return null

  ParserClass ??= require('tree-sitter')
  const parser = new ParserClass()
  parser.setLanguage(lang)
  return parser.parse(source) as ParseTree
}
