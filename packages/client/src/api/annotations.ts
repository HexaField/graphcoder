import type { Annotation, AnnotationKind, AnnotationShape, AnnotationStatus, Geometry } from '@graphcoder/core'

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

// ── Annotations ──────────────────────────────────────────────────────────────

export async function fetchAnnotations(): Promise<{ annotations: Annotation[] }> {
  const res = await fetch(`${API}/api/annotations`)
  return handleResponse<{ annotations: Annotation[] }>(res)
}

export async function fetchAnnotation(id: string): Promise<Annotation> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}`)
  return handleResponse<Annotation>(res)
}

export interface CreateAnnotationInput {
  shape: AnnotationShape
  label: string
  /** Free-form kind name — registered on the server if new */
  kind?: string
  members?: string[]
  description?: string
  status?: AnnotationStatus
  geometry?: Geometry
  parentId?: string | null
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
  updates: Partial<Omit<Annotation, 'id' | 'version' | 'createdAt' | 'updatedAt'>>
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

// ── Kind registry ────────────────────────────────────────────────────────────

export async function fetchKinds(): Promise<{ kinds: AnnotationKind[] }> {
  const res = await fetch(`${API}/api/annotation-kinds`)
  return handleResponse<{ kinds: AnnotationKind[] }>(res)
}

export async function createKind(name: string, description = ''): Promise<AnnotationKind> {
  const res = await fetch(`${API}/api/annotation-kinds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  })
  return handleResponse<AnnotationKind>(res)
}

export async function updateKind(
  name: string,
  updates: { name?: string; color?: string; description?: string }
): Promise<AnnotationKind> {
  const res = await fetch(`${API}/api/annotation-kinds/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  return handleResponse<AnnotationKind>(res)
}

export async function deleteKind(name: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API}/api/annotation-kinds/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  })
  return handleResponse<{ success: boolean }>(res)
}
