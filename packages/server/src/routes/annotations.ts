import { Router } from 'express'
import type { Request, Response } from 'express'
import type { GraphNode } from '@graphcoder/core'
import crypto from 'node:crypto'
import {
  createAnnotation,
  saveAnnotation,
  loadAnnotation,
  loadAllAnnotations,
  deleteAnnotation,
  buildPathFromNodes,
  loadConversation
} from '@graphcoder/core/annotations/server'
import { graphService } from '../codegraph/service.js'
import {
  broadcastAnnotationUpdate,
  broadcastAnnotationProposed,
  broadcastAnnotationRefined,
  broadcastSuggestError
} from '../ws.js'
import { createAnnotationSchema, updateAnnotationSchema } from '../schemas/annotations.js'
import type { Node } from '@colbymchenry/codegraph'

const router = Router()

function getProjectRoot(res: Response): string | null {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return null
  }
  return graphService.getProjectRoot()
}

// GET /annotations/suggest/providers — discover available AI providers
router.get('/suggest/providers', async (_req: Request, res: Response) => {
  try {
    const { discoverProviders } = await import('../suggest/providers/discovery.js')
    const providers = await discoverProviders()
    res.json({ providers })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery failed' })
  }
})

// GET /annotations
router.get('/annotations', (_req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    const annotations = loadAllAnnotations(root)
    res.json({ annotations })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load annotations' })
  }
})

// GET /annotations/:id
router.get('/annotations/:id', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    const annotation = loadAnnotation(root, req.params.id)
    if (!annotation) {
      res.status(404).json({ error: `Annotation ${req.params.id} not found` })
      return
    }
    res.json(annotation)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load annotation' })
  }
})

// POST /annotations
router.post('/annotations', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const parsed = createAnnotationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const { kind, label, members, ...opts } = parsed.data
    const annotation = createAnnotation(kind, label, members, opts)
    saveAnnotation(root, annotation)
    broadcastAnnotationUpdate()
    res.status(201).json(annotation)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create annotation' })
  }
})

// PATCH /annotations/:id
router.patch('/annotations/:id', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const existing = loadAnnotation(root, req.params.id)
  if (!existing) {
    res.status(404).json({ error: `Annotation ${req.params.id} not found` })
    return
  }

  const parsed = updateAnnotationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const updates = parsed.data
    const updated = { ...existing, ...updates }
    saveAnnotation(root, updated)
    broadcastAnnotationUpdate()
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update annotation' })
  }
})

// DELETE /annotations/:id
router.delete('/annotations/:id', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    const found = deleteAnnotation(root, req.params.id)
    if (!found) {
      res.status(404).json({ error: `Annotation ${req.params.id} not found` })
      return
    }
    broadcastAnnotationUpdate()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete annotation' })
  }
})

// GET /annotations/extract-path?from=<nodeId>&to=<nodeId>&depth=<n>
router.get('/annotations/extract-path', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const fromId = req.query['from'] as string | undefined
  const toId = req.query['to'] as string | undefined
  const rawDepth = req.query['depth']
  const depth = typeof rawDepth === 'string' ? parseInt(rawDepth, 10) : 5

  if (!fromId || !toId) {
    res.status(400).json({ error: 'Both "from" and "to" query parameters required' })
    return
  }

  try {
    const cg = graphService.getCodeGraph()
    const fromNode = cg.getNode(fromId)
    const toNode = cg.getNode(toId)
    if (!fromNode) {
      res.status(404).json({ error: `Node ${fromId} not found` })
      return
    }
    if (!toNode) {
      res.status(404).json({ error: `Node ${toId} not found` })
      return
    }

    const visited = new Set<string>()
    const parent = new Map<string, string>()
    const queue = [fromId]
    visited.add(fromId)
    let found = false

    outer: for (let d = 0; d < depth && queue.length > 0; d++) {
      const levelSize = queue.length
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!
        const outgoing = graphService.getOutgoingEdgesAugmented(current)
        for (const edge of outgoing) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target)
            parent.set(edge.target, current)
            if (edge.target === toId) {
              found = true
              break outer
            }
            queue.push(edge.target)
          }
        }
      }
    }

    if (!found) {
      res.json({ found: false, path: null })
      return
    }

    const pathIds: string[] = [toId]
    let cur = toId
    while (parent.has(cur)) {
      cur = parent.get(cur)!
      pathIds.unshift(cur)
    }

    const pathNodes = pathIds.map((id) => cg.getNode(id)).filter((n): n is Node => n !== null) as unknown as GraphNode[]

    const { edges: allEdges } = graphService.getAllNodesAndEdges()
    const pathIdSet = new Set(pathIds)
    const pathEdges = allEdges.filter((e) => {
      if (!pathIdSet.has(e.source) || !pathIdSet.has(e.target)) return false
      const si = pathIds.indexOf(e.source)
      const ti = pathIds.indexOf(e.target)
      return Math.abs(si - ti) === 1
    })

    const extracted = buildPathFromNodes(pathNodes, pathEdges)
    res.json({ found: true, path: extracted })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Path extraction failed' })
  }
})

// POST /annotations/suggest
router.post('/annotations/suggest', async (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  // Validate body: { label: string, prompt: string, kind?: string, provider?: string, depth?: number }
  const { label, prompt, kind, provider, depth } = req.body as {
    label?: string
    prompt?: string
    kind?: string
    provider?: string
    depth?: number
  }

  if (!label || !prompt) {
    res.status(400).json({ error: '"label" and "prompt" are required' })
    return
  }

  // Return 202 immediately, then process async
  const id = crypto.randomUUID()
  res.status(202).json({ id, status: 'processing' })

  // Fire and forget — broadcast result via WebSocket
  try {
    const { suggestAnnotation } = await import('../suggest/orchestrator.js')
    const { annotation } = await suggestAnnotation({ prompt, label, kind: kind as any, provider, depth })
    broadcastAnnotationProposed(annotation.id, annotation.label)
  } catch (err) {
    console.error('[GraphCoder] Suggest failed:', err)
    // The 202 was already sent — notify via WS that suggestion failed
    broadcastSuggestError(id, err instanceof Error ? err.message : 'Suggest failed')
  }
})

// POST /annotations/:id/refine
router.post('/annotations/:id/refine', async (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const { message, provider } = req.body as { message?: string; provider?: string }
  if (!message) {
    res.status(400).json({ error: '"message" is required' })
    return
  }

  try {
    const { refineAnnotation } = await import('../suggest/orchestrator.js')
    const { annotation, conversationLog } = await refineAnnotation({
      annotationId: req.params.id,
      message,
      provider
    })
    broadcastAnnotationRefined(annotation.id)
    res.json({ annotation, conversation: conversationLog })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Refinement failed' })
  }
})

// GET /annotations/:id/conversation
router.get('/annotations/:id/conversation', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    const log = loadConversation(root, req.params.id)
    if (!log) {
      res.json({ conversation: null })
      return
    }
    res.json({ conversation: log })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load conversation' })
  }
})

export default router
