import type { Annotation, ConversationLog } from '@graphcoder/core'

const API: string = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:3001`

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      message = body.error ?? message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export interface AvailableProvider {
  id: string
  label: string
  type: 'openai-compat' | 'cli' | 'test'
  model?: string
}

/** GET /api/suggest/providers — discover available AI backends */
export async function fetchProviders(): Promise<AvailableProvider[]> {
  const res = await fetch(`${API}/api/suggest/providers`)
  const data = await handleResponse<{ providers: AvailableProvider[] }>(res)
  return data.providers
}

/** POST /api/annotations/suggest — returns 202 with { id, status: 'processing' } */
export async function requestSuggestion(input: {
  label: string
  prompt: string
  kind?: string
  provider?: string
  depth?: number
}): Promise<{ id: string; status: string }> {
  const res = await fetch(`${API}/api/annotations/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  return handleResponse<{ id: string; status: string }>(res)
}

/** POST /api/annotations/:id/refine */
export async function refineAnnotation(
  id: string,
  message: string,
  provider?: string
): Promise<{
  annotation: Annotation
  conversation: ConversationLog
}> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, provider })
  })
  return handleResponse<{ annotation: Annotation; conversation: ConversationLog }>(res)
}

/** GET /api/annotations/:id/conversation */
export async function fetchConversation(id: string): Promise<{ conversation: ConversationLog | null }> {
  const res = await fetch(`${API}/api/annotations/${encodeURIComponent(id)}/conversation`)
  return handleResponse<{ conversation: ConversationLog | null }>(res)
}
