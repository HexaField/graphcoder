/**
 * Inline kind input — the naming surface for a freshly drawn shape.
 *
 * Appears at the shape's anchor, never as a modal. Type a kind name;
 * matching existing kinds appear beneath. Tab or arrow keys complete,
 * Enter commits, Escape cancels. Typing a name that does not exist yet
 * creates that kind — this is the only way kinds come into being.
 */
import { type Component, createMemo, createSignal, For, Show, onMount } from 'solid-js'
import { state, UNKINDED_COLOR } from '../state/store.js'

export interface KindInputProps {
  /** Screen position of the shape anchor */
  x: number
  y: number
  /** Shape being named — shown as a hint */
  shape: string
  /** How many nodes the gesture captured */
  memberCount: number
  onCommit: (kind: string, label: string) => void
  onCancel: () => void
}

export const KindInput: Component<KindInputProps> = (props) => {
  const [kindText, setKindText] = createSignal('')
  const [labelText, setLabelText] = createSignal('')
  const [highlighted, setHighlighted] = createSignal(0)
  const [focusedField, setFocusedField] = createSignal<'kind' | 'label'>('kind')

  let kindRef: HTMLInputElement | undefined

  onMount(() => kindRef?.focus())

  /** Existing kinds matching what has been typed so far. */
  const matches = createMemo(() => {
    const q = kindText().trim().toLowerCase()
    const all = state.kinds
    if (!q) return all.slice(0, 6)
    return all.filter((k) => k.name.toLowerCase().includes(q)).slice(0, 6)
  })

  /** True when the typed text names a kind that does not exist yet. */
  const isNewKind = createMemo(() => {
    const q = kindText().trim().toLowerCase()
    if (!q) return false
    return !state.kinds.some((k) => k.name.toLowerCase() === q)
  })

  const acceptSuggestion = () => {
    const m = matches()
    const pick = m[highlighted()]
    if (pick) setKindText(pick.name)
  }

  const commit = () => {
    props.onCommit(kindText(), labelText())
  }

  const onKindKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Tab') {
      // Tab completes the highlighted suggestion, then moves to the label
      e.preventDefault()
      if (matches().length > 0 && kindText().trim()) acceptSuggestion()
      setFocusedField('label')
      ;(e.currentTarget as HTMLInputElement).nextElementSibling?.querySelector('input')?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(matches().length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    }
  }

  const onLabelKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  const swatch = () => {
    const q = kindText().trim().toLowerCase()
    const found = state.kinds.find((k) => k.name.toLowerCase() === q)
    return found?.color ?? UNKINDED_COLOR
  }

  return (
    <div
      class="absolute z-50 w-64 rounded-lg shadow-xl border border-gray-300 dark:border-gray-700
             bg-white dark:bg-gray-900 text-sm"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      data-testid="kind-input"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header — what was drawn */}
      <div
        class="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700
                  text-xs text-gray-500 dark:text-gray-400"
      >
        <span class="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ 'background-color': swatch() }} />
        <span class="font-medium capitalize">{props.shape}</span>
        <Show when={props.memberCount > 0}>
          <span>
            · {props.memberCount} node{props.memberCount !== 1 ? 's' : ''}
          </span>
        </Show>
      </div>

      {/* Kind — free-form, autocompletes over existing kinds */}
      <input
        ref={kindRef}
        type="text"
        class="w-full px-3 py-2 bg-transparent outline-none font-medium
               text-gray-900 dark:text-gray-100 placeholder-gray-400"
        placeholder="Kind (e.g. module, hot path)…"
        value={kindText()}
        data-testid="kind-input-kind"
        onFocus={() => setFocusedField('kind')}
        onInput={(e) => {
          setKindText(e.currentTarget.value)
          setHighlighted(0)
        }}
        onKeyDown={onKindKeyDown}
      />

      {/* Label — what this specific instance is */}
      <div class="border-t border-gray-200 dark:border-gray-700">
        <input
          type="text"
          class="w-full px-3 py-2 bg-transparent outline-none text-gray-700 dark:text-gray-300
                 placeholder-gray-400 text-xs"
          placeholder="Label (optional)…"
          value={labelText()}
          data-testid="kind-input-label"
          onFocus={() => setFocusedField('label')}
          onInput={(e) => setLabelText(e.currentTarget.value)}
          onKeyDown={onLabelKeyDown}
        />
      </div>

      {/* Suggestions from the registry */}
      <Show when={focusedField() === 'kind' && matches().length > 0}>
        <ul class="border-t border-gray-200 dark:border-gray-700 max-h-40 overflow-y-auto py-1">
          <For each={matches()}>
            {(k, i) => (
              <li>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs
                         hover:bg-gray-100 dark:hover:bg-gray-800"
                  classList={{ 'bg-gray-100 dark:bg-gray-800': i() === highlighted() }}
                  data-testid={`kind-suggestion-${k.name}`}
                  onClick={() => {
                    setKindText(k.name)
                    kindRef?.focus()
                  }}
                >
                  <span
                    class="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ 'background-color': k.color }}
                  />
                  <span class="text-gray-800 dark:text-gray-200">{k.name}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      {/* Footer — new-kind notice and key hints */}
      <div
        class="flex items-center justify-between gap-2 px-3 py-1.5 border-t
                  border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400"
      >
        <Show when={isNewKind()} fallback={<span>↑↓ pick · Tab label</span>}>
          <span class="text-emerald-600 dark:text-emerald-400" data-testid="kind-input-new">
            New kind "{kindText().trim()}"
          </span>
        </Show>
        <span>Enter ↵ · Esc</span>
      </div>
    </div>
  )
}
