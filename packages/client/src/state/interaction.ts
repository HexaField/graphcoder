import { createSignal } from 'solid-js'

export type InteractionMode = 'select' | 'boundary' | 'trace' | 'note' | 'question'

const [mode, setModeSignal] = createSignal<InteractionMode>('select')

export const interactionMode = mode

export function setInteractionMode(m: InteractionMode): void {
  setModeSignal(m)
}

export function toggleInteractionMode(m: InteractionMode): void {
  setModeSignal((prev) => (prev === m ? 'select' : m))
}

export const MODE_KEYS: Record<string, InteractionMode> = {
  b: 'boundary',
  t: 'trace',
  n: 'note',
  q: 'question'
}

export const MODE_LABELS: Record<InteractionMode, string> = {
  select: 'Select',
  boundary: 'Boundary (B)',
  trace: 'Trace (T)',
  note: 'Note (N)',
  question: 'Question (Q)'
}
