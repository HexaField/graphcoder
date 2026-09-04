import { z } from 'zod'

const annotationShape = z.enum(['region', 'polyline', 'point'])
const annotationStatus = z.enum(['active', 'proposed', 'stale', 'dismissed'])

/** Kind is free-form — any string the user types. Empty means unkinded. */
const annotationKindName = z.string().max(64)

const geometry = z.object({
  points: z.array(z.tuple([z.number(), z.number()])).default([]),
  anchor: z.object({ x: z.number(), y: z.number() })
})

export const createAnnotationSchema = z.object({
  shape: annotationShape,
  kind: annotationKindName.optional(),
  label: z.string().min(1),
  members: z.array(z.string()).default([]),
  description: z.string().optional(),
  status: annotationStatus.optional(),
  geometry: geometry.optional(),
  parentId: z.string().nullable().optional(),
  author: z.enum(['human', 'agent']).optional(),
  reasoning: z.string().nullable().optional()
})

export const updateAnnotationSchema = z.object({
  shape: annotationShape.optional(),
  kind: annotationKindName.optional(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  status: annotationStatus.optional(),
  members: z.array(z.string()).optional(),
  geometry: geometry.optional(),
  parentId: z.string().nullable().optional(),
  childIds: z.array(z.string()).optional()
})

/** Hex colour, 3 or 6 digits */
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex colour like #3b82f6')

export const createKindSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().optional()
})

export const updateKindSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: hexColor.optional(),
  description: z.string().optional()
})

export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>
export type CreateKindInput = z.infer<typeof createKindSchema>
export type UpdateKindInput = z.infer<typeof updateKindSchema>
