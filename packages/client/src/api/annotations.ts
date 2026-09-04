import type { Annotation, AnnotationKind, AnnotationStatus, PathStep, StepEdge } from '@graphcoder/core'

const API: string = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:3001`

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      message = body.error ?? body.message ?? message
    } catch {
      // ignore parse errors
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function fetchAnnotations(): Promise<{ annotations: Annotation[] }> {
  const res = await fetch(`${API}/api/annotations`)
  return handleResponse<{ annotations: Annotation[] }>(res)
}

export async function fetchAnnotation(id: string): Promise<Annotation> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}`)
  return handleResponse<Annotation>(res)
}

export interface CreateAnnotationInput {
  kind: AnnotationKind
  label: string
  members?: string[]
  description?: string
  status?: AnnotationStatus
  steps?: PathStep[] | null
  stepEdges?: StepEdge[] | null
  resolution?: string | null
  parentId?: string | null
  anchor?: { x: number; y: number; memberLayout: null | { points: [number, number][] } }
  author?: 'human' | 'agent'
}

export async function createAnnotation(input: CreateAnnotationInput): Promise<Annotation> {
  const res = await fetch(`${API}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  return handleResponse<Annotation>(res)
}

export async function updateAnnotation(
  id: string,
  updates: Partial<Omit<Annotation, 'id' | 'version' | 'kind' | 'createdAt' | 'updatedAt'>>
): Promise<Annotation> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  return handleResponse<Annotation>(res)
}

export async function deleteAnnotation(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  return handleResponse<{ success: boolean }>(res)
}
