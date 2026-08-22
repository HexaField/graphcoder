import { z } from 'zod'

export const openProjectSchema = z.object({
  projectRoot: z.string().min(1)
})

export const searchQuerySchema = z.object({
  q: z.string().min(1)
})

export type OpenProjectInput = z.infer<typeof openProjectSchema>
export type SearchQueryInput = z.infer<typeof searchQuerySchema>
