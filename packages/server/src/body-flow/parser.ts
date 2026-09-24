import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface SyntaxNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  namedChildren: SyntaxNode[]
  children: SyntaxNode[]
  parent: SyntaxNode | null
  childForFieldName(name: string): SyntaxNode | null
}

interface ParseTree {
  rootNode: SyntaxNode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>()

function getParser(): typeof ParserClass {
  if (!ParserClass) {
    ParserClass = require('tree-sitter')
  }
  return ParserClass
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadLanguage(langId: string): any {
  const cached = languageCache.get(langId)
  if (cached) return cached

  let grammar
  switch (langId) {
    case 'typescript':
    case 'tsx': {
      const mod = require('tree-sitter-typescript')
      grammar = langId === 'tsx' ? mod.tsx : mod.typescript
      break
    }
    case 'javascript':
    case 'jsx': {
      const mod = require('tree-sitter-typescript')
      grammar = mod.typescript
      break
    }
    default:
      return null
  }

  if (grammar) languageCache.set(langId, grammar)
  return grammar
}

export function parseSource(source: string, language: string): ParseTree | null {
  const lang = loadLanguage(language)
  if (!lang) return null

  const Parser = getParser()
  const parser = new Parser()
  parser.setLanguage(lang)
  return parser.parse(source) as ParseTree
}

export function supportsLanguage(language: string): boolean {
  return ['typescript', 'tsx', 'javascript', 'jsx'].includes(language)
}
