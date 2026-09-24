import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AnnotationMember, GraphNode } from '@graphcoder/core'
import { nodeSemanticId, deriveShape } from '@graphcoder/core'
import crypto from 'node:crypto'
import {
  createAnnotation,
  saveAnnotation,
  loadAnnotation,
  loadAllAnnotations,
  deleteAnnotation,
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

/** Build a semantic ID → GraphNode lookup from the current graph */
function buildSemanticIndex(): Map<string, GraphNode> {
  const { nodes } = graphService.getAllNodesAndEdges()
  const graphNodes = nodes as unknown as GraphNode[]
  const index = new Map<string, GraphNode>()
  for (const n of graphNodes) {
    index.set(nodeSemanticId(n), n)
  }
  return index
}

/** Enrich bare semantic IDs into full AnnotationMember objects */
function enrichMemberIds(memberIds: string[], semanticIndex: Map<string, GraphNode>): AnnotationMember[] {
  return memberIds.map((id) => {
    const node = semanticIndex.get(id)
    return {
      id,
      ref: node ? node.qualifiedName || node.name : '',
      file: node?.filePath ?? '',
      note: ''
    }
  })
}

// GET /annotations/suggest/providers
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

router.get('/annotation-kinds', (_req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return
  try {
    const used = loadAllAnnotations(root)
      .map((a) => a.kind)
      .filter((k) => k.length > 0)
    const kinds = syncKindsFromAnnotations(root, used)
    res.json({ kinds })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load kinds' })
  }
})

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

router.get('/annotations/:slug', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return
  try {
    const annotation = loadAnnotation(root, req.params.slug)
    if (!annotation) {
      res.status(404).json({ error: `Annotation "${req.params.slug}" not found` })
      return
    }
    res.json(annotation)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load annotation' })
  }
})

router.post('/annotations', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return
  const parsed = createAnnotationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const {
      label,
      kind,
      ordered,
      description,
      memberIds,
      members: rawMembers,
      geometry,
      status,
      author,
      reasoning
    } = parsed.data

    let members: AnnotationMember[]
    if (rawMembers && rawMembers.length > 0) {
      members = rawMembers
    } else if (memberIds.length > 0) {
      const semanticIndex = buildSemanticIndex()
      members = enrichMemberIds(memberIds, semanticIndex)
    } else {
      members = []
    }

    const annotation = createAnnotation(label, members, {
      kind,
      ordered,
      description,
      status,
      author,
      reasoning,
      geometry
    })
    const slug = saveAnnotation(root, annotation)
    annotation.id = slug

    if (annotation.kind) ensureKind(root, annotation.kind)
    broadcastAnnotationUpdate()
    res.status(201).json(annotation)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create annotation' })
  }
})

router.patch('/annotations/:slug', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return

  const existing = loadAnnotation(root, req.params.slug)
  if (!existing) {
    res.status(404).json({ error: `Annotation "${req.params.slug}" not found` })
    return
  }

  const parsed = updateAnnotationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const updates = parsed.data

    if (updates.label !== undefined) existing.label = updates.label
    if (updates.kind !== undefined) existing.kind = updates.kind
    if (updates.description !== undefined) existing.description = updates.description
    if (updates.ordered !== undefined) existing.ordered = updates.ordered
    if (updates.status !== undefined) existing.status = updates.status
    if (updates.geometry !== undefined) existing.geometry = updates.geometry

    if (updates.members) {
      existing.members = updates.members
    } else if (updates.memberIds) {
      const semanticIndex = buildSemanticIndex()
      existing.members = enrichMemberIds(updates.memberIds, semanticIndex)
    }

    existing.shape = deriveShape(existing.ordered, existing.members.length)
    saveAnnotation(root, existing)
    if (updates.kind) ensureKind(root, updates.kind)
    broadcastAnnotationUpdate()
    res.json(existing)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update annotation' })
  }
})

router.delete('/annotations/:slug', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return
  try {
    const found = deleteAnnotation(root, req.params.slug)
    if (!found) {
      res.status(404).json({ error: `Annotation "${req.params.slug}" not found` })
      return
    }
    broadcastAnnotationUpdate()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete annotation' })
  }
})

// GET /annotations/extract-path?from=<nodeId>&to=<nodeId>&depth=<n>
router.get('/annotations/extract-path', async (req: Request, res: Response) => {
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

    const { buildPathFromNodes } = await import('@graphcoder/core/annotations/server')
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

  const id = crypto.randomUUID()
  res.status(202).json({ id, status: 'processing' })

  try {
    const { suggestAnnotation } = await import('../suggest/orchestrator.js')
    const { annotation } = await suggestAnnotation({ prompt, label, kind, provider, depth })
    broadcastAnnotationProposed(annotation.id, annotation.label)
  } catch (err) {
    console.error('[GraphCoder] Suggest failed:', err)
    broadcastSuggestError(id, err instanceof Error ? err.message : 'Suggest failed')
  }
})

// POST /annotations/:slug/refine
router.post('/annotations/:slug/refine', async (req: Request, res: Response) => {
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
      annotationId: req.params.slug,
      message,
      provider
    })
    broadcastAnnotationRefined(annotation.id)
    res.json({ annotation, conversation: conversationLog })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Refinement failed' })
  }
})

// GET /annotations/:slug/conversation
router.get('/annotations/:slug/conversation', (req: Request, res: Response) => {
  const root = getProjectRoot(res)
  if (!root) return
  try {
    const log = loadConversation(root, req.params.slug)
    res.json({ conversation: log ?? null })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load conversation' })
  }
})

export default router
