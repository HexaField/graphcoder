/**
 * NodeRef resolver — matches AI-produced human-readable node references
 * to real graph nodes and computes their semantic IDs.
 */
import type { GraphNode, NodeRef, NodeRefResolution } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'

/**
 * Resolve an array of node references against the full graph.
 *
 * For each ref:
 * 1. Exact match — name + kind + filePath all match. Confidence: 'exact'.
 * 2. Fuzzy (name+kind) — filePath differs. Confidence: 'fuzzy'.
 * 3. Fuzzy (name+file) — kind differs. Confidence: 'fuzzy'.
 * 4. Unresolved — no match. semanticId: null.
 */
export function resolveNodeRefs(nodeRefs: NodeRef[], allNodes: GraphNode[]): NodeRefResolution[] {
  return nodeRefs.map((ref) => {
    // 1. Exact match
    const exact = allNodes.find((n) => n.name === ref.name && n.kind === ref.kind && n.filePath === ref.filePath)
    if (exact) {
      return {
        ref,
        semanticId: nodeSemanticId(exact),
        confidence: 'exact' as const
      }
    }

    // 2. Fuzzy: name + kind (file path may differ due to AI imprecision)
    const nameKind = allNodes.find((n) => n.name === ref.name && n.kind === ref.kind)
    if (nameKind) {
      return {
        ref,
        semanticId: nodeSemanticId(nameKind),
        confidence: 'fuzzy' as const
      }
    }

    // 3. Fuzzy: name + filePath (kind may differ)
    const nameFile = allNodes.find((n) => n.name === ref.name && n.filePath === ref.filePath)
    if (nameFile) {
      return {
        ref,
        semanticId: nodeSemanticId(nameFile),
        confidence: 'fuzzy' as const
      }
    }

    // 4. Unresolved
    return {
      ref,
      semanticId: null,
      confidence: 'unresolved' as const
    }
  })
}
