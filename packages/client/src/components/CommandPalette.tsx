/**
 * Command palette — the IDE keyboard surface.
 *
 * Cmd/Ctrl+K opens it. One fuzzy input searches commands, annotations, and
 * kinds together, so everything reachable by mouse is reachable by typing.
 */
import { type Component, createMemo, createSignal, For, Show, createEffect, onMount } from 'solid-js'
import {
  kindColor,
  redo,
  removeAnnotation,
  selectAnnotation,
  showAllKinds,
  startRefinement,
  toggleKindVisibility,
  undo,
  canUndo,
  canRedo,
  state
} from '../state/store.js'
import { setInteractionMode } from '../state/interaction.js'

export interface Command {
  id: string
  title: string
  /** Short right-aligned context — shortcut, kind name, or category */
  hint?: string
  /** Colour swatch shown before the title */
  color?: string
  run: () => void
}

/**
 * Subsequence fuzzy match. Returns a score (lower is better) or null when
 * the query characters do not all appear in order.
 */
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Adjacent matches score better than scattered ones
      score += lastHit === -1 ? ti : ti - lastHit - 1
      lastHit = ti
      qi++
    }
  }
  return qi === q.length ? score : null
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal('')
  const [highlighted, setHighlighted] = createSignal(0)

  let inputRef: HTMLInputElement | undefined

  // Reset each time the palette opens
  createEffect(() => {
    if (props.open) {
      setQuery('')
      setHighlighted(0)
      queueMicrotask(() => inputRef?.focus())
    }
  })

  onMount(() => {
    if (props.open) inputRef?.focus()
  })

  /** Every command the palette can run, before filtering. */
  const allCommands = createMemo((): Command[] => {
    const cmds: Command[] = [
      {
        id: 'draw',
        title: 'Draw annotation',
        hint: 'A',
        run: () => setInteractionMode('annotate')
      },
      {
        id: 'undo',
        title: 'Undo',
        hint: '⌘Z',
        run: () => void undo()
      },
      {
        id: 'redo',
        title: 'Redo',
        hint: '⇧⌘Z',
        run: () => void redo()
      }
    ]

    if (state.hiddenKinds.length > 0) {
      cmds.push({
        id: 'show-all-kinds',
        title: 'Show all kinds',
        hint: `${state.hiddenKinds.length} hidden`,
        run: () => showAllKinds()
      })
    }

    // Toggle visibility per kind
    for (const k of state.kinds) {
      const isHidden = state.hiddenKinds.includes(k.name)
      cmds.push({
        id: `kind-toggle-${k.name}`,
        title: `${isHidden ? 'Show' : 'Hide'} kind: ${k.name}`,
        hint: 'kind',
        color: k.color,
        run: () => toggleKindVisibility(k.name)
      })
    }

    // Jump to an annotation
    for (const a of state.annotations) {
      if (a.status === 'dismissed') continue
      cmds.push({
        id: `goto-${a.id}`,
        title: a.label || '(untitled)',
        hint: a.kind || a.shape,
        color: kindColor(a.kind),
        run: () => selectAnnotation(a.id)
      })
    }

    // Delete an annotation
    for (const a of state.annotations) {
      if (a.status === 'dismissed') continue
      cmds.push({
        id: `delete-${a.id}`,
        title: `Delete: ${a.label || '(untitled)'}`,
        hint: 'delete',
        run: () => void removeAnnotation(a.id)
      })
    }

    // Refine a proposed annotation
    for (const a of state.annotations) {
      if (a.status !== 'proposed') continue
      cmds.push({
        id: `refine-${a.id}`,
        title: `Refine: ${a.label || '(untitled)'}`,
        hint: 'AI',
        run: () => void startRefinement(a.id)
      })
    }

    return cmds
  })

  const results = createMemo(() => {
    const q = query().trim()
    const scored: Array<{ cmd: Command; score: number }> = []
    for (const cmd of allCommands()) {
      const score = fuzzyScore(q, cmd.title)
      if (score !== null) scored.push({ cmd, score })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, 12).map((s) => s.cmd)
  })

  const runHighlighted = () => {
    const cmd = results()[highlighted()]
    if (!cmd) return
    cmd.run()
    props.onClose()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runHighlighted()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(results().length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] bg-black/30"
        data-testid="command-palette-backdrop"
        onClick={() => props.onClose()}
      >
        <div
          class="w-[520px] max-w-[90vw] rounded-lg shadow-2xl border border-gray-300 dark:border-gray-700
                 bg-white dark:bg-gray-900 overflow-hidden"
          data-testid="command-palette"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            class="w-full px-4 py-3 bg-transparent outline-none text-sm
                   text-gray-900 dark:text-gray-100 placeholder-gray-400
                   border-b border-gray-200 dark:border-gray-700"
            placeholder="Search commands, annotations, kinds…"
            value={query()}
            data-testid="command-palette-input"
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setHighlighted(0)
            }}
            onKeyDown={onKeyDown}
          />

          <Show
            when={results().length > 0}
            fallback={<div class="px-4 py-6 text-xs text-gray-400 text-center">No matches</div>}
          >
            <ul class="max-h-80 overflow-y-auto py-1">
              <For each={results()}>
                {(cmd, i) => (
                  <li>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-4 py-2 text-left text-sm
                             hover:bg-gray-100 dark:hover:bg-gray-800"
                      classList={{ 'bg-gray-100 dark:bg-gray-800': i() === highlighted() }}
                      data-testid={`command-item-${cmd.id}`}
                      onMouseEnter={() => setHighlighted(i())}
                      onClick={() => {
                        cmd.run()
                        props.onClose()
                      }}
                    >
                      <Show when={cmd.color}>
                        <span
                          class="inline-block w-2 h-2 rounded-full flex-shrink-0"
                          style={{ 'background-color': cmd.color }}
                        />
                      </Show>
                      <span class="flex-1 truncate text-gray-800 dark:text-gray-200">{cmd.title}</span>
                      <Show when={cmd.hint}>
                        <span class="text-[10px] text-gray-400 flex-shrink-0">{cmd.hint}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <div
            class="flex items-center gap-3 px-4 py-1.5 border-t border-gray-200 dark:border-gray-700
                      text-[10px] text-gray-400"
          >
            <span>↑↓ navigate</span>
            <span>↵ run</span>
            <span>esc close</span>
            <span class="ml-auto">
              {canUndo() ? '⌘Z undo' : ''} {canRedo() ? '⇧⌘Z redo' : ''}
            </span>
          </div>
        </div>
      </div>
    </Show>
  )
}
