import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EditError } from '@graphcoder/core/edit'
import { editFile } from '@graphcoder/core/edit/node'
import { option } from './options.js'

const DESCRIPTION = `Edit code by naming a symbol instead of quoting its text. Reads the file from disk itself: no Read needed first. Ops run in order; if one fails, nothing is written.
- replace {symbol, code}: swap a whole declaration. Leading comments in code replace the old comments, leading decorators the old decorators. What code omits stays: comments, decorators, export/pub, a comment after the declaration on its last line. For a function held in a const, code without const/let/export replaces only the value.
- replace_in {symbol?, find, to?, code}: replace text inside a symbol, or anywhere in the file without one. find, and to after it, must each match once; indentation differences are forgiven. to extends the match to the end of to. After an exact match code goes in as written; otherwise it is re-indented to the match.
- insert {code, after?|before?}: add code beside a symbol, or at the end of the file.
- remove {symbol}: delete a declaration with its comments, decorators and overloads.
- create {code}: make a new file (first op only).
symbol: name, Container::name or Container.name; add @line when names repeat. In TS/JS, Python, Go and Rust files that parse, edits that break the syntax are rejected. Returns a unified diff, plus callers when a signature changes.`

const op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), symbol: z.string(), code: z.string() }),
  z.object({
    op: z.literal('replace_in'),
    symbol: z.string().optional(),
    find: z.string(),
    to: z.string().optional(),
    code: z.string()
  }),
  z.object({ op: z.literal('insert'), code: z.string(), after: z.string().optional(), before: z.string().optional() }),
  z.object({ op: z.literal('remove'), symbol: z.string() }),
  z.object({ op: z.literal('create'), code: z.string() })
])

/** Directories edits may touch: `--edit-roots` (path-delimited), else the home directory. */
function roots(): string[] | undefined {
  const raw = option('edit-roots')?.split(path.delimiter).filter(Boolean)
  return raw?.length ? raw : undefined
}

export function registerEditTool(server: McpServer) {
  return server.tool(
    'edit',
    DESCRIPTION,
    {
      file: z.string().describe('Absolute path of the file'),
      ops: z.array(op).min(1),
      dryRun: z.boolean().optional().describe('Report the diff without writing')
    },
    async (args) => {
      try {
        const result = await editFile(args, { roots: roots() })
        return { content: [{ type: 'text' as const, text: result.report }] }
      } catch (err) {
        const text =
          err instanceof EditError
            ? `${err.message}\nNothing was written.`
            : `edit failed: ${(err as Error).stack ?? err}`
        return { content: [{ type: 'text' as const, text }], isError: true }
      }
    }
  )
}
