/**
 * Git REST routes
 *
 *  GET  /api/git/status             — is the project a Git repo?
 *  GET  /api/git/branches           — list local branches
 *  GET  /api/git/commits            — list commits (?branch=X&limit=N)
 *  POST /api/git/diff               — compute ArchDiff between two commits (SSE stream)
 *
 * All routes require a project to be open. They delegate to the git service
 * for basic queries and to the temporal mapper for snapshot extraction.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { computeArchDiff } from '@graphcoder/core'
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
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 200 : Math.min(rawLimit, 1000)
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

    // ── Cache check ──────────────────────────────────────────────────────
    const cached = getCachedDiff(projectRoot, baseHash, targetHash)
    if (cached) {
      sendEvent('progress', { message: 'Cache hit — returning stored diff' })
      sendEvent('result', cached)
      res.end()
      return
    }

    // ── Extract snapshots ────────────────────────────────────────────────
    sendEvent('progress', { message: `Extracting snapshot 1/2 (${base})…` })
    const baseSnap = await snapshotAtCommit(projectRoot, baseHash, (msg) =>
      sendEvent('progress', { message: `[base] ${msg}` })
    )

    sendEvent('progress', { message: `Extracting snapshot 2/2 (${target})…` })
    const targetSnap = await snapshotAtCommit(projectRoot, targetHash, (msg) =>
      sendEvent('progress', { message: `[target] ${msg}` })
    )

    // ── Compute diff ─────────────────────────────────────────────────────
    sendEvent('progress', { message: 'Computing diff…' })
    const diff = computeArchDiff(baseSnap, targetSnap)

    // Cache and return.
    setCachedDiff(projectRoot, baseHash, targetHash, diff)
    sendEvent('result', diff)
    res.end()
  } catch (err) {
    sendEvent('error', { error: err instanceof Error ? err.message : 'Internal error' })
    res.end()
  }
})

export default router
