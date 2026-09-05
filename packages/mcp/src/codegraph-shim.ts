/**
 * CJS interop — CodeGraph ships CommonJS, this project uses ESM.
 *
 * createRequire bridges the gap without ts-node or transpiler config hacks.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cg = require('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph')

export const CodeGraph = cg.CodeGraph
export const NODE_KINDS = cg.NODE_KINDS
