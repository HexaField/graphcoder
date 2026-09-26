// Edit code by symbol name. Pure: an Analyzer supplies declarations and
// syntax verdicts (see `@graphcoder/core/edit/node` for the one backed by
// codegraph and tree-sitter).

export * from './types.js'
export { applyOps, type ApplyOptions, type EditOutcome, type SignatureChange } from './apply.js'
export { resolveSymbol, describe } from './resolve.js'
export { unifiedDiff } from './diff.js'
export {
  findAnchor,
  AnchorError,
  normaliseSource,
  restoreSource,
  reindent,
  declarationHead,
  leadingElement,
  lineOf,
  offsetOf,
  type AnchorHit,
  type CodeTraits,
  type NormalisedSource
} from './text.js'
