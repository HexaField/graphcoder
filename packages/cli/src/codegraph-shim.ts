/**
 * CJS interop shim for @colbymchenry/codegraph.
 *
 * CodeGraph ships as CJS; createRequire gives reliable interop in our ESM
 * package. This shim centralises the require so the rest of the CLI uses
 * plain imports.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cg = require('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph')

export const CodeGraph = cg.CodeGraph
export const NODE_KINDS = cg.NODE_KINDS
