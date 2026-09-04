import type { Annotation } from './types.js'

export interface ResolutionResult {
  resolved: string[] // semantic IDs that matched
  unresolved: string[] // semantic IDs that didn't match
}

/**
 * Resolve an annotation's member semantic IDs against a set of known IDs.
 * Also resolves path step architectureNodeIds if present.
 */
export function resolveAnnotation(annotation: Annotation, knownSemanticIds: Set<string>): ResolutionResult {
  const resolved: string[] = []
  const unresolved: string[] = []

  // Check direct members
  for (const id of annotation.members) {
    if (knownSemanticIds.has(id)) {
      resolved.push(id)
    } else {
      unresolved.push(id)
    }
  }

  // Check path steps
  if (annotation.steps) {
    for (const step of annotation.steps) {
      if (step.architectureNodeId) {
        if (knownSemanticIds.has(step.architectureNodeId)) {
          resolved.push(step.architectureNodeId)
        } else {
          unresolved.push(step.architectureNodeId)
        }
      }
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
