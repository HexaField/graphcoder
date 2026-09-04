import type { Annotation } from './types.js'

export interface ResolutionResult {
  resolved: string[] // semantic IDs that matched
  unresolved: string[] // semantic IDs that didn't match
}

/**
 * Resolve an annotation's member semantic IDs against a set of known IDs.
 * Members carry the full node set for every shape, so this covers regions,
 * polylines, and points alike.
 */
export function resolveAnnotation(annotation: Annotation, knownSemanticIds: Set<string>): ResolutionResult {
  const resolved: string[] = []
  const unresolved: string[] = []

  for (const id of annotation.members) {
    if (knownSemanticIds.has(id)) {
      resolved.push(id)
    } else {
      unresolved.push(id)
    }
  }

  return { resolved, unresolved }
}

/**
 * Check all annotations and return those that have unresolved members.
 */
export function findStaleAnnotations(
  annotations: Annotation[],
  knownSemanticIds: Set<string>
): Map<string, ResolutionResult> {
  const stale = new Map<string, ResolutionResult>()
  for (const ann of annotations) {
    const result = resolveAnnotation(ann, knownSemanticIds)
    if (result.unresolved.length > 0) {
      stale.set(ann.id, result)
    }
  }
  return stale
}
