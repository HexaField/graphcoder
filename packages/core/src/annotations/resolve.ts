import type { Annotation, AnnotationMember } from './types.js'

export interface ResolutionResult {
  resolved: AnnotationMember[]
  unresolved: AnnotationMember[]
}

export function resolveAnnotation(annotation: Annotation, knownSemanticIds: Set<string>): ResolutionResult {
  const resolved: AnnotationMember[] = []
  const unresolved: AnnotationMember[] = []

  for (const member of annotation.members) {
    if (knownSemanticIds.has(member.id)) {
      resolved.push(member)
    } else {
      unresolved.push(member)
    }
  }

  return { resolved, unresolved }
}

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
