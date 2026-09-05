/**
 * Git REST routes
 *
 *  GET  /api/git/status             — is the project a Git repo?
 *  GET  /api/git/branches           — list local branches
 *  GET  /api/git/commits            — list commits (?branch=X&limit=N)
 *  POST /api/git/diff               — compute ArchDiff between two commits (SSE stream)
 *  GET  /api/git/pr-stack           — discover a stacked PR chain (?base=X&tip=Y)
 *  POST /api/git/pr-stack/import    — import PR stack as proposed annotations
 *
 * All routes require a project to be open. They delegate to the git service
 * for basic queries and to the temporal mapper for snapshot extraction.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import simpleGit from 'simple-git'
import { computeArchDiff, nodeSemanticId } from '@graphcoder/core'
import { createAnnotation, saveAnnotation, loadAllAnnotations, ensureKind } from '@graphcoder/core/annotations/server'
import { graphService } from '../codegraph/service.js'
import { getGitGraph, getGitStatus, listBranches, listCommits, resolveRef } from '../git/index.js'
import { getCachedDiff, setCachedDiff } from '../temporal/cache.js'
import { snapshotAtCommit } from '../temporal/mapper.js'

const router = Router()

// ── GET /git/status ───────────────────────────────────────────────────────────

router.get('/git/status', async (_req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }
  const projectRoot = graphService.getProjectRoot()
  const status = await getGitStatus(projectRoot)
  res.json(status)
})

// ── GET /git/branches ─────────────────────────────────────────────────────────

router.get('/git/branches', async (_req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }
  try {
    const projectRoot = graphService.getProjectRoot()
    const result = await listBranches(projectRoot)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list branches' })
  }
})

// ── GET /git/commits ──────────────────────────────────────────────────────────

router.get('/git/commits', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }
  try {
    const projectRoot = graphService.getProjectRoot()
    const branch = typeof req.query['branch'] === 'string' ? req.query['branch'] : undefined
    const rawLimit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : NaN
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200)
    const commits = await listCommits(projectRoot, branch, limit)
    res.json({ commits })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list commits' })
  }
})

// ── GET /git/graph ───────────────────────────────────────────────────────────

router.get('/git/graph', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }
  try {
    const projectRoot = graphService.getProjectRoot()
    const rawLimit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : NaN
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 200 : Math.min(rawLimit, 2000)
    const graph = await getGitGraph(projectRoot, limit)
    res.json(graph)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build git graph' })
  }
})

// ── POST /git/diff ────────────────────────────────────────────────────────────
//
// Body: { base: string, target: string }
// Response: text/event-stream
//
// SSE events:
//   progress  { message: string }          — indexing status updates
//   result    ArchDiff                     — the computed diff (final event)
//   error     { error: string }            — fatal error

router.post('/git/diff', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { base, target } = req.body as { base?: string; target?: string }
  if (!base || !target) {
    res.status(400).json({ error: '"base" and "target" are required' })
    return
  }

  const projectRoot = graphService.getProjectRoot()

  // ── SSE setup ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    // ── Resolve refs ─────────────────────────────────────────────────────
    sendEvent('progress', { message: `Resolving refs…` })
    const [baseHash, targetHash] = await Promise.all([resolveRef(projectRoot, base), resolveRef(projectRoot, target)])

    // ── Extract snapshots (always — client needs them for the diff view) ─
    sendEvent('progress', { message: `Extracting snapshot 1/2 (${base})…` })
    const baseSnap = await snapshotAtCommit(projectRoot, baseHash, (msg) =>
      sendEvent('progress', { message: `[base] ${msg}` })
    )

    sendEvent('progress', { message: `Extracting snapshot 2/2 (${target})…` })
    const targetSnap = await snapshotAtCommit(projectRoot, targetHash, (msg) =>
      sendEvent('progress', { message: `[target] ${msg}` })
    )

    // ── Diff (cached or fresh) ──────────────────────────────────────────
    const cached = getCachedDiff(projectRoot, baseHash, targetHash)
    let diff: ReturnType<typeof computeArchDiff>
    if (cached) {
      sendEvent('progress', { message: 'Diff cache hit' })
      diff = cached
    } else {
      sendEvent('progress', { message: 'Computing diff…' })
      diff = computeArchDiff(baseSnap, targetSnap)
      setCachedDiff(projectRoot, baseHash, targetHash, diff)
    }

    // Return diff + both snapshots so the client can build a diff view.
    sendEvent('result', { diff, baseSnapshot: baseSnap, targetSnapshot: targetSnap })
    res.end()
  } catch (err) {
    sendEvent('error', { error: err instanceof Error ? err.message : 'Internal error' })
    res.end()
  }
})

// ── PR Stack helpers ──────────────────────────────────────────────────────────

interface PrSlice {
  index: number
  branch: string
  title: string
  commitHash: string
  parentBranch: string
  files: string[]
  stats: { additions: number; deletions: number }
}

async function discoverPrStack(projectRoot: string, base: string, tip: string): Promise<PrSlice[]> {
  const git = simpleGit(projectRoot)
  const logResult = await git.log({ from: base, to: tip })
  const commits = [...logResult.all].reverse() // oldest first

  const slices: PrSlice[] = []
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    const parentRef = i === 0 ? base : commits[i - 1].hash
    const diffSummary = await git.diffSummary([`${parentRef}..${commit.hash}`])

    slices.push({
      index: i + 1,
      branch: '', // can't reliably derive branch name from commit alone
      title: commit.message,
      commitHash: commit.hash,
      parentBranch: i === 0 ? base : commits[i - 1].hash.slice(0, 8),
      files: diffSummary.files.map((f) => f.file),
      stats: {
        additions: diffSummary.insertions,
        deletions: diffSummary.deletions
      }
    })
  }
  return slices
}

// ── GET /git/pr-stack ─────────────────────────────────────────────────────────

router.get('/git/pr-stack', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const base = req.query.base as string | undefined
  const tip = req.query.tip as string | undefined
  if (!base || !tip) {
    res.status(400).json({ error: 'Both base and tip query params required' })
    return
  }

  try {
    const projectRoot = graphService.getProjectRoot()
    const slices = await discoverPrStack(projectRoot, base, tip)

    // Enrich with graph node semantic IDs per slice
    const { nodes } = graphService.getAllNodesAndEdges()
    const nodesByFile = new Map<string, typeof nodes>()
    for (const node of nodes) {
      const fp = node.filePath
      if (!fp) continue
      const list = nodesByFile.get(fp) ?? []
      list.push(node)
      nodesByFile.set(fp, list)
    }

    const enriched = slices.map((slice) => {
      const memberIds = new Set<string>()
      for (const file of slice.files) {
        for (const node of nodesByFile.get(file) ?? []) {
          memberIds.add(nodeSemanticId(node))
        }
      }
      return { ...slice, memberIds: [...memberIds] }
    })

    res.json({ prs: enriched })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to discover PR stack' })
  }
})

// ── POST /git/pr-stack/import ────────────────────────────────────────────────

router.post('/git/pr-stack/import', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { base, tip } = req.body as { base?: string; tip?: string }
  if (!base || !tip) {
    res.status(400).json({ error: 'Both base and tip required in body' })
    return
  }

  try {
    const projectRoot = graphService.getProjectRoot()
    const slices = await discoverPrStack(projectRoot, base, tip)

    // Build file → semantic ID map
    const { nodes } = graphService.getAllNodesAndEdges()
    const nodesByFile = new Map<string, typeof nodes>()
    for (const node of nodes) {
      const fp = node.filePath
      if (!fp) continue
      const list = nodesByFile.get(fp) ?? []
      list.push(node)
      nodesByFile.set(fp, list)
    }

    // Register the 'pr' kind
    ensureKind(projectRoot, 'pr')

    // Check existing annotations to avoid duplicates
    const existing = loadAllAnnotations(projectRoot)
    const existingLabels = new Set(existing.map((a) => a.label))

    const created = []
    for (const slice of slices) {
      const label = `PR${slice.index}: ${slice.title}`
      if (existingLabels.has(label)) continue

      const memberIds: string[] = []
      const seen = new Set<string>()
      for (const file of slice.files) {
        for (const node of nodesByFile.get(file) ?? []) {
          const sid = nodeSemanticId(node)
          if (!seen.has(sid)) {
            seen.add(sid)
            memberIds.push(sid)
          }
        }
      }

      if (memberIds.length === 0) continue

      const annotation = createAnnotation('region', label, memberIds, {
        kind: 'pr',
        description: `Commit ${slice.commitHash.slice(0, 8)}: ${slice.title}`,
        status: 'proposed',
        author: 'agent'
      })
      saveAnnotation(projectRoot, annotation)
      created.push(annotation)
    }

    res.json({ created: created.length, annotations: created })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to import PR stack' })
  }
})

export default router
