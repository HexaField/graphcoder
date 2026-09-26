// Runs an edit against a real file: path guards, read, the pure engine,
// compare-and-swap, atomic write, and what the codegraph index knows about
// the change (callers of a changed signature, affected tests).

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyOps, type SignatureChange } from '../apply.js'
import { unifiedDiff } from '../diff.js'
import { normaliseSource, restoreSource } from '../text.js'
import { EditError, type Analyzer, type EditArgs } from '../types.js'
import { createAnalyzer } from './analyzer.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const MAX_BYTES = 1024 * 1024
const DENIED_DIRS = new Set(['.git', 'node_modules'])
const SECRET_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i
const NOT_SECRET = /^\.env\.(?:example|sample|template)$/i
const CALLER_CAP = 15
const TEST_CAP = 8

export interface EditFileOptions {
  analyzer?: Analyzer
  /** Directories edits may touch. Default: the user's home directory. */
  roots?: string[]
  /** Look up callers and affected tests in the codegraph index. Default true. */
  graph?: boolean
}

export interface EditFileResult {
  /** The real path edited. */
  path: string
  written: boolean
  report: string
}

let sharedAnalyzer: Analyzer | undefined

export async function editFile(args: EditArgs, opts: EditFileOptions = {}): Promise<EditFileResult> {
  if (!path.isAbsolute(args.file)) throw new EditError(`file must be an absolute path: ${args.file}`)
  const analyzer = opts.analyzer ?? (sharedAnalyzer ??= createAnalyzer())
  const target = realTarget(args.file)
  guard(target, opts.roots ?? [os.homedir()])

  const exists = fs.existsSync(target)
  const raw = exists ? readText(target) : ''
  const source = normaliseSource(raw)
  const label = projectRelative(target)
  const outcome = applyOps(target, source.text, args.ops, analyzer, { label, exists })

  if (outcome.text === source.text) {
    return {
      path: target,
      written: false,
      report: `No change to ${label}: the ops leave the text as it was. Nothing written.`
    }
  }

  const root = opts.graph === false ? undefined : codegraphRoot(target)
  const changes = await changeReport(root, target, outcome.signatureChanges)
  const next = restoreSource(outcome.text, source)

  if (!args.dryRun) {
    if (exists) {
      if (sha256(fs.readFileSync(target, 'utf8')) !== sha256(raw)) {
        throw new EditError(`${label} changed on disk during the edit; retry.`)
      }
      writeAtomic(target, next)
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, next, { flag: 'wx' })
    }
  }
  const tests = root && !args.dryRun ? await affectedTests(root, target) : []

  const lines = [
    `${args.dryRun ? 'Dry run, nothing written:' : exists ? 'Edited' : 'Created'} ${label}`,
    ...outcome.notes,
    ...(outcome.syntaxChecked ? ['syntax ok'] : []),
    ...changes,
    ...(tests.length ? [`affected tests: ${tests.join(', ')}`] : []),
    ...(!args.dryRun && exists ? ['Read the file again before using the built-in Edit on it.'] : []),
    '',
    unifiedDiff(source.text, outcome.text)
  ]
  return { path: target, written: !args.dryRun, report: lines.join('\n') }
}

/** The path to write: a symlink's target, or for a new file, the real parent plus the new name. */
function realTarget(file: string): string {
  const resolved = path.resolve(file)
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved)
  const missing: string[] = []
  let dir = resolved
  while (!fs.existsSync(dir)) {
    missing.unshift(path.basename(dir))
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.join(fs.realpathSync(dir), ...missing)
}

function guard(target: string, roots: string[]): void {
  const realRoots = roots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : path.resolve(r)))
  if (!realRoots.some((r) => target === r || target.startsWith(r + path.sep))) {
    throw new EditError(`${target} is outside the allowed roots (${realRoots.join(', ')}).`)
  }
  const segments = target.split(path.sep)
  if (segments.some((s) => DENIED_DIRS.has(s)))
    throw new EditError(`Refusing to edit inside .git or node_modules: ${target}`)
  const base = path.basename(target)
  if (SECRET_FILE.test(base) && !NOT_SECRET.test(base))
    throw new EditError(`Refusing to edit a secrets or key file: ${base}`)
}

function readText(file: string): string {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new EditError(`Not a regular file: ${file}`)
  if (stat.size > MAX_BYTES) throw new EditError(`${file} is ${stat.size} bytes; the limit is ${MAX_BYTES}.`)
  const raw = fs.readFileSync(file, 'utf8')
  if (raw.includes('\0')) throw new EditError(`${file} looks binary.`)
  return raw
}

/** Temp file in the same directory, same mode, renamed over the target. */
function writeAtomic(file: string, content: string): void {
  const mode = fs.statSync(file).mode & 0o7777
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, content)
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Path relative to the enclosing git checkout, else the base name. */
function projectRelative(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.relative(dir, file)
    if (path.dirname(dir) === dir) return path.basename(file)
  }
}

// ── codegraph index lookups (best effort) ────────────────────────────────────

interface CodeGraphLike {
  getNodesInFile(filePath: string): Array<{ id: string; qualifiedName: string }>
  getCallers(
    nodeId: string,
    maxDepth?: number
  ): Array<{ node: { filePath: string; startLine: number }; edge: { line?: number } }>
  close(): void
}

function codegraphRoot(file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

/**
 * One line per changed signature or name, plus its callers from the index,
 * read before the write while the index still describes the old code.
 */
async function changeReport(root: string | undefined, file: string, changes: SignatureChange[]): Promise<string[]> {
  if (changes.length === 0) return []
  let cg: CodeGraphLike | undefined
  let inFile: Array<{ id: string; qualifiedName: string }> = []
  try {
    if (root) {
      const { CodeGraph } = require('@colbymchenry/codegraph') as {
        CodeGraph: { open(root: string, opts: { readOnly: boolean; sync: boolean }): Promise<CodeGraphLike> }
      }
      cg = await CodeGraph.open(root, { readOnly: true, sync: false })
      inFile = cg.getNodesInFile(path.relative(root, file))
    }
  } catch {
    // The index is optional: report the changes without callers.
  }
  const out: string[] = []
  for (const change of changes) {
    out.push(
      change.renamedTo
        ? `renamed ${change.qualifiedName} → ${change.renamedTo}`
        : `signature changed: ${change.qualifiedName} ${change.before ?? '?'} → ${change.after ?? '?'}`
    )
    const node = inFile.find((n) => n.qualifiedName === change.qualifiedName)
    if (!cg || !node) continue
    const sites = [
      ...new Set(cg.getCallers(node.id, 1).map((c) => `${c.node.filePath}:${c.edge.line ?? c.node.startLine}`))
    ]
    if (sites.length) {
      const more = sites.length > CALLER_CAP ? `, … ${sites.length - CALLER_CAP} more` : ''
      out.push(`  callers to check: ${sites.slice(0, CALLER_CAP).join(', ')}${more}`)
    }
  }
  cg?.close()
  return out
}

async function affectedTests(root: string, file: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'codegraph',
      ['affected', path.relative(root, file), '-p', root, '--quiet'],
      {
        timeout: 5_000
      }
    )
    const tests = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return tests.length > TEST_CAP ? [...tests.slice(0, TEST_CAP), `… ${tests.length - TEST_CAP} more`] : tests
  } catch {
    return []
  }
}
