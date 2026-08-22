import { Router } from 'express'
import type { Request, Response } from 'express'
import { graphService } from '../codegraph/service.js'
import { broadcastGraphUpdate } from '../ws.js'
import { openProjectSchema, searchQuerySchema } from '../schemas/graph.js'
import type { Node } from '@colbymchenry/codegraph'

const router = Router()

// POST /projects/open
router.post('/projects/open', async (req: Request, res: Response) => {
  const parsed = openProjectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'projectRoot is required and must be a non-empty string' })
    return
  }

  const { projectRoot } = parsed.data

  try {
    await graphService.open(projectRoot)
    broadcastGraphUpdate()
    const stats = graphService.getCodeGraph().getStats()
    res.json({
      success: true,
      projectRoot,
      stats: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        fileCount: stats.fileCount
      }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to open project' })
  }
})

// GET /projects/current
router.get('/projects/current', (_req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.json({ open: false })
    return
  }

  try {
    const projectRoot = graphService.getProjectRoot()
    const stats = graphService.getCodeGraph().getStats()
    res.json({ open: true, projectRoot, stats })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /graph
router.get('/graph', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  try {
    const { nodes, edges } = graphService.getAllNodesAndEdges()
    const kindsParam = typeof req.query['kinds'] === 'string' ? req.query['kinds'] : null

    if (kindsParam) {
      const kindSet = new Set(kindsParam.split(',').map((k) => k.trim()))
      const filteredNodes = nodes.filter((n) => kindSet.has(n.kind))
      const filteredIdSet = new Set(filteredNodes.map((n) => n.id))
      const filteredEdges = edges.filter((e) => filteredIdSet.has(e.source) && filteredIdSet.has(e.target))
      res.json({ nodes: filteredNodes, edges: filteredEdges })
    } else {
      res.json({ nodes, edges })
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/search — must be registered before /nodes/:nodeId
router.get('/nodes/search', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const parsed = searchQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Query parameter "q" is required' })
    return
  }

  try {
    const cg = graphService.getCodeGraph()
    const results = cg.searchNodes(parsed.data.q)
    res.json({ results: results.map((r) => ({ node: r.node, score: r.score })) })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/:nodeId
router.get('/nodes/:nodeId', async (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { nodeId } = req.params

  try {
    const cg = graphService.getCodeGraph()
    const node = cg.getNode(nodeId)

    if (!node) {
      res.status(404).json({ error: `Node ${nodeId} not found` })
      return
    }

    const incoming = cg.getIncomingEdges(nodeId)
    const outgoing = cg.getOutgoingEdges(nodeId)
    const code = await cg.getCode(nodeId)

    res.json({ node, incoming, outgoing, code })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/:nodeId/callers
router.get('/nodes/:nodeId/callers', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { nodeId } = req.params

  try {
    const cg = graphService.getCodeGraph()

    if (!cg.getNode(nodeId)) {
      res.status(404).json({ error: `Node ${nodeId} not found` })
      return
    }

    const incoming = cg.getIncomingEdges(nodeId).filter((e) => e.kind === 'calls')
    const callerNodes = incoming.map((e) => cg.getNode(e.source)).filter((n): n is Node => n !== null)

    res.json({ nodes: callerNodes, edges: incoming })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/:nodeId/callees
router.get('/nodes/:nodeId/callees', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { nodeId } = req.params

  try {
    const cg = graphService.getCodeGraph()

    if (!cg.getNode(nodeId)) {
      res.status(404).json({ error: `Node ${nodeId} not found` })
      return
    }

    const outgoing = cg.getOutgoingEdges(nodeId).filter((e) => e.kind === 'calls')
    const calleeNodes = outgoing.map((e) => cg.getNode(e.target)).filter((n): n is Node => n !== null)

    res.json({ nodes: calleeNodes, edges: outgoing })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/:nodeId/impact
router.get('/nodes/:nodeId/impact', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { nodeId } = req.params
  const rawDepth = req.query['depth']
  const depthParam = typeof rawDepth === 'string' ? parseInt(rawDepth, 10) : NaN
  const depth = isNaN(depthParam) ? 3 : depthParam

  try {
    const cg = graphService.getCodeGraph()

    if (!cg.getNode(nodeId)) {
      res.status(404).json({ error: `Node ${nodeId} not found` })
      return
    }

    const subgraph = cg.getImpactRadius(nodeId, depth)
    res.json({
      nodes: Array.from(subgraph.nodes.values()),
      edges: subgraph.edges,
      rootId: nodeId
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /nodes/:nodeId/callgraph
router.get('/nodes/:nodeId/callgraph', (req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  const { nodeId } = req.params
  const rawDepth = req.query['depth']
  const depthParam = typeof rawDepth === 'string' ? parseInt(rawDepth, 10) : NaN
  const depth = isNaN(depthParam) ? 3 : depthParam

  try {
    const cg = graphService.getCodeGraph()

    if (!cg.getNode(nodeId)) {
      res.status(404).json({ error: `Node ${nodeId} not found` })
      return
    }

    const subgraph = cg.getCallGraph(nodeId, depth)
    res.json({
      nodes: Array.from(subgraph.nodes.values()),
      edges: subgraph.edges,
      rootId: nodeId
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// GET /files
router.get('/files', (_req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  try {
    const cg = graphService.getCodeGraph()
    const fileRecords = cg.getFiles()

    const files = fileRecords.map((fr) => {
      const nodes = cg.getNodesInFile(fr.path)
      return {
        filePath: fr.path,
        language: fr.language,
        nodeCount: nodes.length,
        nodes
      }
    })

    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

// POST /sync
router.post('/sync', async (_req: Request, res: Response) => {
  if (!graphService.isOpen()) {
    res.status(503).json({ error: 'No project open' })
    return
  }

  try {
    const cg = graphService.getCodeGraph()
    await cg.sync()
    broadcastGraphUpdate()
    const stats = cg.getStats()
    res.json({
      success: true,
      stats: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        fileCount: stats.fileCount
      }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
})

export default router
