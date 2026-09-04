import { z } from 'zod'

const annotationKind = z.enum(['boundary', 'path', 'note', 'question', 'projection'])
const annotationStatus = z.enum(['draft', 'active', 'proposed', 'stale', 'applied', 'resolved', 'dismissed'])
const stepKind = z.enum(['entry', 'process', 'decision', 'exit', 'ux-only'])

const pathStep = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  architectureNodeId: z.string().nullable(),
  stepKind
})

const stepEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().nullable()
})

const annotationAnchor = z.object({
  x: z.number(),
  y: z.number(),
  memberLayout: z.object({ points: z.array(z.tuple([z.number(), z.number()])) }).nullable()
})

export const createAnnotationSchema = z.object({
  kind: annotationKind,
  label: z.string().min(1),
  members: z.array(z.string()).default([]),
  description: z.string().optional(),
  status: annotationStatus.optional(),
  steps: z.array(pathStep).nullable().optional(),
  stepEdges: z.array(stepEdge).nullable().optional(),
  resolution: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  anchor: annotationAnchor.optional(),
  author: z.enum(['human', 'agent']).optional(),
  reasoning: z.string().nullable().optional()
})

export const updateAnnotationSchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  status: annotationStatus.optional(),
  members: z.array(z.string()).optional(),
  steps: z.array(pathStep).nullable().optional(),
  stepEdges: z.array(stepEdge).nullable().optional(),
  resolution: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  childIds: z.array(z.string()).optional(),
  anchor: annotationAnchor.optional()
})

export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>
