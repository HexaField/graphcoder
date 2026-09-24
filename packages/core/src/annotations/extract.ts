import type { GraphNode } from '../index.js'
import type { AnnotationMember } from './types.js'
import { nodeSemanticId } from '../identity.js'

export interface ExtractedPath {
  members: AnnotationMember[]
  names: string[]
}

export function buildPathFromNodes(orderedNodes: GraphNode[]): ExtractedPath {
  return {
    members: orderedNodes.map((n) => ({
      id: nodeSemanticId(n),
      ref: n.qualifiedName || n.name,
      file: n.filePath,
      note: ''
    })),
    names: orderedNodes.map((n) => n.name)
  }
}
