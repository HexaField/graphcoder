// @colbymchenry/codegraph ships as CJS; use createRequire for reliable interop
// in our ESM server package.
import { createRequire } from 'node:module'
import type { CodeGraph as CodeGraphType, Node, Edge } from '@colbymchenry/codegraph'
import { analyzeHttpBridge } from './http-bridge.js'

const require = createRequire(import.meta.url)
const { CodeGraph, NODE_KINDS } = require('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph')

export class GraphService {
  private cg: CodeGraphType | null = null
  private projectRoot: string | null = null

  /**
   * Synthetic `calls` edges produced by the HTTP bridge analyser.
   * These connect client fetch() callers to server route handler nodes.
   */
  private httpEdges: Edge[] = []

  async open(projectRoot: string): Promise<void> {
    if (this.cg) {
      this.cg.unwatch()
      this.cg.close()
      this.cg = null
      this.projectRoot = null
      this.httpEdges = []
    }

    const initialized = CodeGraph.isInitialized(projectRoot)

    if (initialized) {
      console.log(`Opening existing CodeGraph project at ${projectRoot}`)
      this.cg = await CodeGraph.open(projectRoot)
    } else {
      console.log(`Initializing new CodeGraph project at ${projectRoot}`)
      this.cg = await CodeGraph.init(projectRoot)
      console.log('Indexing all files...')
      await this.cg.indexAll({
        onProgress: (progress) => {
          const file = progress.currentFile ? ` — ${progress.currentFile}` : ''
          console.log(`[${progress.phase}] ${progress.current}/${progress.total}${file}`)
        }
      })
      console.log('Indexing complete')
    }

    // watch() fails with ENOSPC when the system inotify limit is exhausted.
    // Degrade gracefully — indexing and querying still work, just no auto-sync.
    try {
      this.cg.watch()
    } catch (err) {
      console.warn('[GraphCoder] File watching unavailable (ENOSPC or similar); changes will not auto-sync:', err)
    }
    this.projectRoot = projectRoot

    // Run the HTTP bridge analysis after the graph is ready.
    await this.refreshHttpBridge()
  }

  getCodeGraph(): CodeGraphType {
    if (!this.cg) {
      throw new Error('No CodeGraph project is open. Call POST /api/projects/open first.')
    }
    return this.cg
  }

  getProjectRoot(): string {
    if (!this.projectRoot) {
      throw new Error('No CodeGraph project is open.')
    }
    return this.projectRoot
  }

  isOpen(): boolean {
    return this.cg !== null
  }

  async close(): Promise<void> {
    if (this.cg) {
      this.cg.unwatch()
      this.cg.close()
      this.cg = null
      this.projectRoot = null
      this.httpEdges = []
    }
  }

  /**
   * Re-run the HTTP bridge analysis and update the cached synthetic edges.
   * Called automatically on open() and can be called after sync().
   */
  async refreshHttpBridge(): Promise<void> {
    if (!this.cg || !this.projectRoot) return

    const { nodes } = this.getAllNodesAndEdges({ includeSynthetic: false })
    const filePaths = this.cg.getFiles().map((f) => f.path)

    this.httpEdges = await analyzeHttpBridge(this.projectRoot, nodes, filePaths)
    console.log(`[HTTP Bridge] Synthesized ${this.httpEdges.length} cross-boundary call edge(s)`)
  }

  /**
   * Return all nodes and edges. Synthetic HTTP-bridge edges are included by default.
   * Pass { includeSynthetic: false } to get only the raw codegraph data.
   */
  getAllNodesAndEdges(opts: { includeSynthetic?: boolean } = {}): { nodes: Node[]; edges: Edge[] } {
    const includeSynthetic = opts.includeSynthetic !== false
    const cg = this.getCodeGraph()
    const nodes: Node[] = []
    const seenIds = new Set<string>()

    for (const kind of NODE_KINDS) {
      for (const node of cg.getNodesByKind(kind)) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id)
          nodes.push(node)
        }
      }
    }

    const edges: Edge[] = []
    for (const node of nodes) {
      edges.push(...cg.getOutgoingEdges(node.id))
    }

    if (includeSynthetic && this.httpEdges.length > 0) {
      // Deduplicate synthetic edges against natural edges already in the graph.
      const naturalEdgeKeys = new Set(edges.map((e) => `${e.source}\x00${e.target}\x00${e.kind}`))
      for (const e of this.httpEdges) {
        const key = `${e.source}\x00${e.target}\x00${e.kind}`
        if (!naturalEdgeKeys.has(key)) {
          edges.push(e)
        }
      }
    }

    return { nodes, edges }
  }

  /**
   * Return incoming edges for a node, including synthetic HTTP-bridge edges.
   */
  getIncomingEdgesAugmented(nodeId: string): Edge[] {
    const natural = this.getCodeGraph().getIncomingEdges(nodeId)
    const synthetic = this.httpEdges.filter((e) => e.target === nodeId)
    if (synthetic.length === 0) return natural

    // Deduplicate against natural edges
    const naturalKeys = new Set(natural.map((e) => `${e.source}\x00${e.kind}`))
    const fresh = synthetic.filter((e) => !naturalKeys.has(`${e.source}\x00${e.kind}`))
    return [...natural, ...fresh]
  }

  /**
   * Return outgoing edges for a node, including synthetic HTTP-bridge edges.
   */
  getOutgoingEdgesAugmented(nodeId: string): Edge[] {
    const natural = this.getCodeGraph().getOutgoingEdges(nodeId)
    const synthetic = this.httpEdges.filter((e) => e.source === nodeId)
    if (synthetic.length === 0) return natural

    // Deduplicate against natural edges
    const naturalKeys = new Set(natural.map((e) => `${e.target}\x00${e.kind}`))
    const fresh = synthetic.filter((e) => !naturalKeys.has(`${e.target}\x00${e.kind}`))
    return [...natural, ...fresh]
  }
}

export const graphService = new GraphService()
