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
  loadConversation,
  ensureKind,
  updateKind,
  deleteKind,
  syncKindsFromAnnotations
} from '@graphcoder/core/annotations/server'
import { graphService } from '../codegraph/service.js'
import {
  broadcastAnnotationUpdate,
  broadcastAnnotationProposed,
  broadcastAnnotationRefined,
  broadcastSuggestError
} from '../ws.js'
import {
  createAnnotationSchema,
  updateAnnotationSchema,
  createKindSchema,
  updateKindSchema
} from '../schemas/annotations.js'
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

// ── Kind registry ────────────────────────────────────────────────────────────

// GET /annotation-kinds — list user-defined kinds, reconciled with usage
router.get('/annotation-kinds', (_req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    // Register any kind found on an annotation but missing from the registry,
    // so hand-edited files and AI-coined kinds still get a stable colour.
    const used = loadAllAnnotations(root)
      .map((a) => a.kind)
      .filter((k) => k.length > 0)
    const kinds = syncKindsFromAnnotations(root, used)
    res.json({ kinds })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load kinds' })
  }
})

// POST /annotation-kinds — register a kind (idempotent)
router.post('/annotation-kinds', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const parsed = createKindSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const kind = ensureKind(root, parsed.data.name, parsed.data.description ?? '')
    if (!kind) {
      res.status(400).json({ error: 'Kind name cannot be blank' })
      return
    }
    broadcastAnnotationUpdate()
    res.status(201).json(kind)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create kind' })
  }
})

// PATCH /annotation-kinds/:name — rename, recolour, or describe
router.patch('/annotation-kinds/:name', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const parsed = updateKindSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const oldName = req.params.name
    const updated = updateKind(root, oldName, parsed.data)
    if (!updated) {
      res.status(404).json({ error: `Kind "${oldName}" not found, blank, or name already taken` })
      return
    }

    // A rename must carry every annotation of that kind with it
    if (parsed.data.name !== undefined && parsed.data.name !== oldName) {
      const key = oldName.trim().toLowerCase()
      for (const ann of loadAllAnnotations(root)) {
        if (ann.kind.trim().toLowerCase() === key) {
          ann.kind = updated.name
          saveAnnotation(root, ann)
        }
      }
    }

    broadcastAnnotationUpdate()
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update kind' })
  }
})

// DELETE /annotation-kinds/:name — unregister; annotations keep the string
router.delete('/annotation-kinds/:name', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  try {
    const found = deleteKind(root, req.params.name)
    if (!found) {
      res.status(404).json({ error: `Kind "${req.params.name}" not found` })
      return
    }
    broadcastAnnotationUpdate()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete kind' })
  }
})

// ── Annotations ──────────────────────────────────────────────────────────────

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
    const { shape, label, members, ...opts } = parsed.data
    const annotation = createAnnotation(shape, label, members, opts)
    saveAnnotation(root, annotation)
    // Typing a new kind name registers it — this is how kinds come into being
    if (annotation.kind) ensureKind(root, annotation.kind)
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
    // Re-kinding an annotation registers the new kind
    if (updates.kind) ensureKind(root, updates.kind)
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

    const extracted = buildPathFromNodes(pathNodes)
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
