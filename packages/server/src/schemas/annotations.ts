import { z } from 'zod'

const annotationMember = z.object({
  id: z.string(),
  ref: z.string().default(''),
  file: z.string().default(''),
  note: z.string().default('')
})

export const createAnnotationSchema = z.object({
  label: z.string().min(1),
  kind: z.string().max(64).default(''),
  ordered: z.boolean().default(false),
  description: z.string().default(''),
  /** Client sends semantic IDs; server enriches to full members */
  memberIds: z.array(z.string()).default([]),
  /** Or client sends full members (AI suggest flow) */
  members: z.array(annotationMember).optional(),
  /** Geometry from drawing gesture — cached locally, not committed */
  geometry: z
    .object({
      points: z.array(z.tuple([z.number(), z.number()])).default([]),
      anchor: z.object({ x: z.number(), y: z.number() })
    })
    .optional(),
  status: z.enum(['active', 'proposed']).optional(),
  author: z.enum(['human', 'agent']).optional(),
  reasoning: z.string().nullable().optional()
})

export const updateAnnotationSchema = z.object({
  label: z.string().min(1).optional(),
  kind: z.string().max(64).optional(),
  description: z.string().optional(),
  ordered: z.boolean().optional(),
  members: z.array(annotationMember).optional(),
  memberIds: z.array(z.string()).optional(),
  status: z.enum(['active', 'proposed', 'stale', 'dismissed']).optional(),
  geometry: z
    .object({
      points: z.array(z.tuple([z.number(), z.number()])).default([]),
      anchor: z.object({ x: z.number(), y: z.number() })
    })
    .optional()
})

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
