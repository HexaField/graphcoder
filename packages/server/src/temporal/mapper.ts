/**
 * Temporal mapper — extracts a graph snapshot for a specific Git commit.
 *
 * Strategy:
 *   1. Check the SQLite cache; return immediately on hit.
 *   2. On miss: create a `git worktree` at a temp path, initialise CodeGraph
 *      on it, extract all nodes + edges, remove the worktree, and cache the
 *      snapshot before returning.
 *
 * The worktree approach guarantees the working tree matches the commit exactly
 * without disturbing the live project checkout.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import type { GraphSnapshot } from '@graphcoder/core'
import type { CodeGraph as CodeGraphType } from '@colbymchenry/codegraph'
import { getCachedSnapshot, setCachedSnapshot } from './cache.js'
import { analyzeHttpBridge } from '../codegraph/http-bridge.js'

const require = createRequire(import.meta.url)
const { CodeGraph, NODE_KINDS } = require('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph')

export type ProgressCallback = (message: string) => void

/**
 * Extract all nodes and edges from a CodeGraph instance, including
 * HTTP-bridge synthetic edges from the worktree source files.
 *
 * The bridge scans source files for fetch() calls and matches their
 * normalised URLs against route nodes — exactly the same analysis
 * that the live GraphService runs, but against historical source.
 */
async function extractSnapshot(cg: CodeGraphType, worktreePath: string): Promise<GraphSnapshot> {
  const nodes = []
  const seenIds = new Set<string>()

  for (const kind of NODE_KINDS) {
    for (const node of cg.getNodesByKind(kind)) {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id)
        nodes.push(node)
      }
    }
  }

  const edges = []
  for (const node of nodes) {
    edges.push(...cg.getOutgoingEdges(node.id))
  }

  // Run HTTP bridge on the worktree source — produces synthetic `calls`
  // edges from client fetch() sites to server route handler nodes.
  const filePaths = cg.getFiles().map((f: { path: string }) => f.path)
  const bridgeEdges = await analyzeHttpBridge(worktreePath, nodes, filePaths)
  if (bridgeEdges.length > 0) {
    const naturalKeys = new Set(edges.map((e) => `${e.source}\x00${e.target}\x00${e.kind}`))
    for (const e of bridgeEdges) {
      const key = `${e.source}\x00${e.target}\x00${e.kind}`
      if (!naturalKeys.has(key)) edges.push(e)
    }
  }

  // Cast: CodeGraph's Node/Edge shapes are wire-compatible with GraphNode/GraphEdge.
  return { nodes: nodes as unknown as GraphSnapshot['nodes'], edges: edges as unknown as GraphSnapshot['edges'] }
}

/**
 * Return a graph snapshot for `commitHash` in `projectRoot`.
 *
 * Calls `onProgress` with status strings during indexing so the caller can
 * stream them back to the client via SSE.
 *
 * Results are cached in `{projectRoot}/.graphcoder/temporal.sqlite`.
 */
export async function snapshotAtCommit(
  projectRoot: string,
  commitHash: string,
  onProgress?: ProgressCallback
): Promise<GraphSnapshot> {
  // ── Cache hit ──────────────────────────────────────────────────────────────
  const cached = getCachedSnapshot(projectRoot, commitHash)
  if (cached) {
    onProgress?.(`Cache hit for ${commitHash.slice(0, 8)}`)
    return cached
  }

  // ── Worktree setup ─────────────────────────────────────────────────────────
  const worktreeBase = join(tmpdir(), `graphcoder-wt-`)
  const worktreePath = mkdtempSync(worktreeBase)

  onProgress?.(`Creating worktree for ${commitHash.slice(0, 8)}…`)

  const git = simpleGit(projectRoot)

  try {
    // Detached-HEAD worktree at the target commit — does not create a branch.
    await git.raw(['worktree', 'add', '--detach', worktreePath, commitHash])

    // ── CodeGraph indexing ─────────────────────────────────────────────────
    onProgress?.(`Indexing ${commitHash.slice(0, 8)}…`)

    let cg: CodeGraphType
    if (CodeGraph.isInitialized(worktreePath)) {
      cg = await CodeGraph.open(worktreePath)
    } else {
      cg = await CodeGraph.init(worktreePath)
      await cg.indexAll({
        onProgress: (p) => {
          const file = p.currentFile ? ` — ${p.currentFile}` : ''
          onProgress?.(`[${p.phase}] ${p.current}/${p.total}${file}`)
        }
      })
    }

    // ── Extract & cache ────────────────────────────────────────────────────
    onProgress?.(`Extracting graph for ${commitHash.slice(0, 8)}…`)
    const snapshot = await extractSnapshot(cg, worktreePath)
    cg.close()

    setCachedSnapshot(projectRoot, commitHash, snapshot)
    onProgress?.(`Snapshot ready: ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges`)

    return snapshot
  } finally {
    // Always clean up the worktree, even on error.
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath])
    } catch {
      // Fall back to direct rm if git worktree remove fails (e.g. git < 2.17)
      try {
        rmSync(worktreePath, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}
