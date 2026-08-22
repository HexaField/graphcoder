import { CodeGraph, NODE_KINDS } from '@colbymchenry/codegraph'
import type { Node, Edge } from '@colbymchenry/codegraph'

export class GraphService {
  private cg: CodeGraph | null = null
  private projectRoot: string | null = null

  async open(projectRoot: string): Promise<void> {
    if (this.cg) {
      this.cg.unwatch()
      this.cg.close()
      this.cg = null
      this.projectRoot = null
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

    this.cg.watch()
    this.projectRoot = projectRoot
  }

  getCodeGraph(): CodeGraph {
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
    }
  }

  getAllNodesAndEdges(): { nodes: Node[]; edges: Edge[] } {
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

    return { nodes, edges }
  }
}

export const graphService = new GraphService()
