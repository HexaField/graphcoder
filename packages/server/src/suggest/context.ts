/**
 * Context gatherer — assembles a structured context package from the
 * CodeGraph before invoking the AI provider.
 *
 * The gathered context gives the AI enough architectural information to
 * reason about the codebase without reading full source files.
 */
import type { AnnotationKind } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { loadAllAnnotations } from '@graphcoder/core/annotations/server'
import { graphService } from '../codegraph/service.js'

/** A graph node in the context package — enough for the AI to reference. */
export interface ContextNode {
  id: string
  semanticId: string
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  signature: string | null
  startLine: number
  endLine: number
}

/** The full context package sent to the AI provider. */
export interface SuggestContext {
  project: string
  prompt: string
  label: string
  constrainedKind: AnnotationKind | null
  matchedNodes: ContextNode[]
  callGraph: { edges: Array<{ source: string; target: string; kind: string }> }
  fileTree: string[]
  existingAnnotations: Array<{ id: string; kind: string; label: string; members: string[] }>
}

/**
 * Score a node against prompt terms. Returns 0 for no match.
 * Splits the prompt into individual terms for multi-word queries.
 */
function scoreNode(node: { name: string; qualifiedName: string; filePath: string }, prompt: string): number {
  const terms = prompt
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
  if (terms.length === 0) return 0

  const nameLower = node.name.toLowerCase()
  const qualLower = node.qualifiedName.toLowerCase()
  const fileLower = node.filePath.toLowerCase()

  let totalScore = 0
  let matchCount = 0

  for (const term of terms) {
    if (nameLower === term) {
      totalScore += 100
      matchCount++
    } else if (nameLower.includes(term)) {
      totalScore += 50
      matchCount++
    } else if (qualLower.includes(term)) {
      totalScore += 25
      matchCount++
    } else if (fileLower.includes(term)) {
      totalScore += 10
      matchCount++
    }
  }

  // Bonus for matching multiple terms — rewards broader relevance.
  if (matchCount > 1) totalScore += matchCount * 15

  return totalScore
}

/**
 * Gather context from the CodeGraph for an AI suggest request.
 *
 * Steps:
 * 1. Match nodes to prompt text (top 20 by score).
 * 2. Expand neighbourhood — callers + callees up to `depth` levels.
 * 3. Collect edges between expanded nodes.
 * 4. Collect unique file paths.
 * 5. Load existing annotations.
 */
export function gatherContext(
  prompt: string,
  label: string,
  constrainedKind: AnnotationKind | null,
  depth: number = 3
): SuggestContext {
  const projectRoot = graphService.getProjectRoot()
  const { nodes, edges: _allEdges } = graphService.getAllNodesAndEdges()

  // 1. Score and rank nodes against prompt text.
  const scored = nodes
    .map((node) => ({ node, score: scoreNode(node, prompt) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  const matchedNodes: ContextNode[] = scored.map((m) => ({
    id: m.node.id,
    semanticId: nodeSemanticId(m.node),
    kind: m.node.kind,
    name: m.node.name,
    qualifiedName: m.node.qualifiedName,
    filePath: m.node.filePath,
    signature: m.node.signature ?? null,
    startLine: m.node.startLine,
    endLine: m.node.endLine
  }))

  // 2. Expand neighbourhood — BFS outward from matched nodes.
  const expandedIds = new Set(matchedNodes.map((n) => n.id))
  const edgeKeys = new Set<string>()

  let frontier = [...expandedIds]
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = []
    for (const nodeId of frontier) {
      const outgoing = graphService.getOutgoingEdgesAugmented(nodeId)
      const incoming = graphService.getIncomingEdgesAugmented(nodeId)

      for (const edge of [...outgoing, ...incoming]) {
        edgeKeys.add(`${edge.source}\x00${edge.target}\x00${edge.kind}`)
        const neighborId = edge.source === nodeId ? edge.target : edge.source
        if (!expandedIds.has(neighborId)) {
          expandedIds.add(neighborId)
          nextFrontier.push(neighborId)
        }
      }
    }
    frontier = nextFrontier
  }

  // 3. Collect edges between expanded nodes.
  const callGraphEdges: Array<{ source: string; target: string; kind: string }> = []
  for (const key of edgeKeys) {
    const [source, target, kind] = key.split('\x00') as [string, string, string]
    if (expandedIds.has(source) && expandedIds.has(target)) {
      callGraphEdges.push({ source, target, kind })
    }
  }

  // 4. Collect unique file paths from expanded nodes.
  const filePaths = new Set<string>()
  const cg = graphService.getCodeGraph()
  for (const id of expandedIds) {
    const node = cg.getNode(id)
    if (node?.filePath) filePaths.add(node.filePath)
  }

  // 5. Load existing annotations.
  const existing = loadAllAnnotations(projectRoot).map((ann) => ({
    id: ann.id,
    kind: ann.kind,
    label: ann.label,
    members: ann.members
  }))

  return {
    project: projectRoot,
    prompt,
    label,
    constrainedKind,
    matchedNodes,
    callGraph: { edges: callGraphEdges },
    fileTree: [...filePaths].sort(),
    existingAnnotations: existing
  }
}
