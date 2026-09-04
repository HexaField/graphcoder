import type { GraphNode } from '../index.js'

export interface ExtractedPath {
  /** Ordered semantic node IDs — becomes a polyline annotation's members */
  members: string[]
  /** Node names in traversal order, for a default label */
  names: string[]
}

/**
 * Turn an ordered node walk into polyline annotation members.
 *
 * v2 keeps traversal order in `members` itself, so extraction no longer
 * builds a parallel step structure — the ordered ID list is the path.
 */
export function buildPathFromNodes(orderedNodes: GraphNode[]): ExtractedPath {
  return {
    members: orderedNodes.map((n) => n.id),
    names: orderedNodes.map((n) => n.name)
  }
}
