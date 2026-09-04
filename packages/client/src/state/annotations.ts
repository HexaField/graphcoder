import type { Annotation, AnnotationKind, ConversationLog } from '@graphcoder/core'
import { batch } from 'solid-js'
import * as api from '../api/annotations.js'
import { state, setState } from './core.js'
import type { AvailableProvider } from '../api/suggest.js'

export interface AnnotationsState {
  annotations: Annotation[]
  selectedAnnotationId: string | null
  isLoadingAnnotations: boolean
  annotationError: string | null
  suggestingIds: string[]
  refiningAnnotationId: string | null
  conversation: ConversationLog | null
  isRefining: boolean
  availableProviders: AvailableProvider[]
  selectedProvider: string | null
}

export const annotationsInitial: AnnotationsState = {
  annotations: [],
  selectedAnnotationId: null,
  isLoadingAnnotations: false,
  annotationError: null,
  suggestingIds: [],
  refiningAnnotationId: null,
  conversation: null,
  isRefining: false,
  availableProviders: [],
  selectedProvider: null
}

export async function loadAnnotations(): Promise<void> {
  setState('isLoadingAnnotations', true)
  setState('annotationError', null)
  try {
    const { annotations } = await api.fetchAnnotations()
    setState('annotations', annotations)
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to load annotations')
  } finally {
    setState('isLoadingAnnotations', false)
  }
}

export async function addAnnotation(
  kind: AnnotationKind,
  label: string,
  members: string[] = [],
  opts?: Partial<api.CreateAnnotationInput>
): Promise<Annotation | null> {
  try {
    const annotation = await api.createAnnotation({ kind, label, members, ...opts })
    setState('annotations', (prev) => [...prev, annotation])
    return annotation
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to create annotation')
    return null
  }
}

export async function patchAnnotation(id: string, updates: Parameters<typeof api.updateAnnotation>[1]): Promise<void> {
  try {
    const updated = await api.updateAnnotation(id, updates)
    setState('annotations', (prev) => prev.map((a) => (a.id === id ? updated : a)))
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to update annotation')
  }
}

export async function removeAnnotation(id: string): Promise<void> {
  try {
    await api.deleteAnnotation(id)
    batch(() => {
      setState('annotations', (prev) => prev.filter((a) => a.id !== id))
      if (state.selectedAnnotationId === id) {
        setState('selectedAnnotationId', null)
      }
    })
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to delete annotation')
  }
}

export function selectAnnotation(id: string | null): void {
  setState('selectedAnnotationId', id)
}

export async function loadProviders(): Promise<void> {
  try {
    const suggestApi = await import('../api/suggest.js')
    const providers = await suggestApi.fetchProviders()
    setState('availableProviders', providers)
    // Auto-select the first non-test provider, or test if nothing else available
    if (providers.length > 0 && !state.selectedProvider) {
      const nonTest = providers.find((p) => p.type !== 'test')
      setState('selectedProvider', nonTest?.id ?? providers[0]!.id)
    }
  } catch {
    // Discovery failed — leave empty, SuggestForm will show a message
  }
}

export function setSelectedProvider(id: string): void {
  setState('selectedProvider', id)
}

export async function requestSuggest(label: string, prompt: string, kind?: string, provider?: string): Promise<void> {
  try {
    const suggestApi = await import('../api/suggest.js')
    const providerToUse = provider ?? state.selectedProvider ?? undefined
    const { id } = await suggestApi.requestSuggestion({ label, prompt, kind, provider: providerToUse })
    setState('suggestingIds', (prev) => [...prev, id])
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to request suggestion')
  }
}

export function removeSuggestingId(id: string): void {
  setState('suggestingIds', (prev) => prev.filter((s) => s !== id))
}

export async function startRefinement(annotationId: string): Promise<void> {
  setState('refiningAnnotationId', annotationId)
  setState('conversation', null)
  try {
    const suggestApi = await import('../api/suggest.js')
    const { conversation } = await suggestApi.fetchConversation(annotationId)
    setState('conversation', conversation)
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to load conversation')
  }
}

export function stopRefinement(): void {
  setState('refiningAnnotationId', null)
  setState('conversation', null)
  setState('isRefining', false)
}

export async function sendRefinement(annotationId: string, message: string): Promise<void> {
  setState('isRefining', true)
  try {
    const suggestApi = await import('../api/suggest.js')
    const { annotation, conversation } = await suggestApi.refineAnnotation(annotationId, message)
    setState('annotations', (prev) => prev.map((a) => (a.id === annotationId ? annotation : a)))
    setState('conversation', conversation)
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Refinement failed')
  } finally {
    setState('isRefining', false)
  }
}

export async function acceptAnnotation(id: string): Promise<void> {
  await patchAnnotation(id, { status: 'active' })
  stopRefinement()
}

export async function dismissAnnotation(id: string): Promise<void> {
  await patchAnnotation(id, { status: 'dismissed' })
  stopRefinement()
}
