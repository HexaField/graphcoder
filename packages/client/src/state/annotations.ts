import type { Annotation, AnnotationKind, AnnotationShape, ConversationLog, Geometry } from '@graphcoder/core'
import { batch } from 'solid-js'
import * as api from '../api/annotations.js'
import { state, setState } from './core.js'
import type { AvailableProvider } from '../api/suggest.js'

/** Fallback colour for annotations whose kind is not in the registry yet */
export const UNKINDED_COLOR = '#94a3b8'

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
  /** User-defined kind registry */
  kinds: AnnotationKind[]
  /** Kind names hidden from the canvas; empty means show everything */
  hiddenKinds: string[]
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
  selectedProvider: null,
  kinds: [],
  hiddenKinds: []
}

// ── Kind registry ────────────────────────────────────────────────────────────

/** Look up a kind's colour. Unregistered or blank kinds get the neutral grey. */
export function kindColor(kindName: string): string {
  if (!kindName) return UNKINDED_COLOR
  const key = kindName.trim().toLowerCase()
  const found = state.kinds.find((k) => k.name.trim().toLowerCase() === key)
  return found?.color ?? UNKINDED_COLOR
}

export async function loadKinds(): Promise<void> {
  try {
    const { kinds } = await api.fetchKinds()
    setState('kinds', kinds)
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to load kinds')
  }
}

export async function renameKind(oldName: string, newName: string): Promise<void> {
  try {
    await api.updateKind(oldName, { name: newName })
    // A rename rewrites every annotation of that kind server-side
    await Promise.all([loadKinds(), loadAnnotations()])
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to rename kind')
  }
}

export async function recolorKind(name: string, color: string): Promise<void> {
  try {
    const updated = await api.updateKind(name, { color })
    setState('kinds', (prev) => prev.map((k) => (k.name === name ? updated : k)))
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to recolour kind')
  }
}

export async function removeKind(name: string): Promise<void> {
  try {
    await api.deleteKind(name)
    setState('kinds', (prev) => prev.filter((k) => k.name !== name))
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to delete kind')
  }
}

export function toggleKindVisibility(name: string): void {
  setState('hiddenKinds', (prev) => (prev.includes(name) ? prev.filter((k) => k !== name) : [...prev, name]))
}

export function showAllKinds(): void {
  setState('hiddenKinds', [])
}

// ── Annotations ──────────────────────────────────────────────────────────────

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
  shape: AnnotationShape,
  label: string,
  members: string[] = [],
  opts?: Partial<api.CreateAnnotationInput>
): Promise<Annotation | null> {
  try {
    const annotation = await api.createAnnotation({ shape, label, members, ...opts })
    setState('annotations', (prev) => [...prev, annotation])
    pushUndo({ type: 'create', annotation })
    // A new kind may have just come into existence
    if (annotation.kind && !state.kinds.some((k) => k.name === annotation.kind)) {
      void loadKinds()
    }
    return annotation
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to create annotation')
    return null
  }
}

export async function patchAnnotation(
  id: string,
  updates: Parameters<typeof api.updateAnnotation>[1],
  recordUndo = true
): Promise<void> {
  const before = state.annotations.find((a) => a.id === id)
  try {
    const updated = await api.updateAnnotation(id, updates)
    setState('annotations', (prev) => prev.map((a) => (a.id === id ? updated : a)))
    if (recordUndo && before) pushUndo({ type: 'update', before, after: updated })
    if (updated.kind && !state.kinds.some((k) => k.name === updated.kind)) {
      void loadKinds()
    }
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to update annotation')
  }
}

export async function removeAnnotation(id: string, recordUndo = true): Promise<void> {
  const before = state.annotations.find((a) => a.id === id)
  try {
    await api.deleteAnnotation(id)
    batch(() => {
      setState('annotations', (prev) => prev.filter((a) => a.id !== id))
      if (state.selectedAnnotationId === id) {
        setState('selectedAnnotationId', null)
      }
    })
    if (recordUndo && before) pushUndo({ type: 'delete', annotation: before })
  } catch (e) {
    setState('annotationError', e instanceof Error ? e.message : 'Failed to delete annotation')
  }
}

export function selectAnnotation(id: string | null): void {
  setState('selectedAnnotationId', id)
}

/** Change an annotation's kind, registering the kind if new. */
export async function setAnnotationKind(id: string, kind: string): Promise<void> {
  await patchAnnotation(id, { kind })
}

/** Replace an annotation's geometry after a canvas edit. */
export async function setAnnotationGeometry(id: string, geometry: Geometry, members: string[]): Promise<void> {
  await patchAnnotation(id, { geometry, members })
}

// ── Undo / redo ──────────────────────────────────────────────────────────────

type UndoEntry =
  | { type: 'create'; annotation: Annotation }
  | { type: 'delete'; annotation: Annotation }
  | { type: 'update'; before: Annotation; after: Annotation }

const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
const UNDO_LIMIT = 100

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry)
  if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  // A fresh action invalidates the redo branch
  redoStack.length = 0
}

/** Recreate an annotation from a snapshot, preserving its content. */
async function restore(annotation: Annotation): Promise<void> {
  await api.createAnnotation({
    shape: annotation.shape,
    kind: annotation.kind,
    label: annotation.label,
    members: annotation.members,
    description: annotation.description,
    status: annotation.status,
    geometry: annotation.geometry,
    parentId: annotation.parentId,
    author: annotation.author
  })
  await loadAnnotations()
}

export async function undo(): Promise<void> {
  const entry = undoStack.pop()
  if (!entry) return

  if (entry.type === 'create') {
    await removeAnnotation(entry.annotation.id, false)
  } else if (entry.type === 'delete') {
    await restore(entry.annotation)
  } else {
    await patchAnnotation(entry.before.id, entry.before, false)
  }

  redoStack.push(entry)
}

export async function redo(): Promise<void> {
  const entry = redoStack.pop()
  if (!entry) return

  if (entry.type === 'create') {
    await restore(entry.annotation)
  } else if (entry.type === 'delete') {
    await removeAnnotation(entry.annotation.id, false)
  } else {
    await patchAnnotation(entry.after.id, entry.after, false)
  }

  undoStack.push(entry)
}

export function canUndo(): boolean {
  return undoStack.length > 0
}

export function canRedo(): boolean {
  return redoStack.length > 0
}

// ── AI providers + suggestion ────────────────────────────────────────────────

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
