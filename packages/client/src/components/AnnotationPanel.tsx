/**
 * Annotation outline — an IDE-style explorer for annotations.
 *
 * Annotations group under their user-defined kind, the way a file explorer
 * groups files under folders. Each group carries the kind's colour swatch,
 * a count, a visibility toggle, and inline rename/recolour.
 */
import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import type { Annotation, ConversationTurn } from '@graphcoder/core'
import {
  kindColor,
  loadProviders,
  patchAnnotation,
  recolorKind,
  removeAnnotation,
  removeKind,
  renameKind,
  requestSuggest,
  selectAnnotation,
  sendRefinement,
  setSelectedProvider,
  showAllKinds,
  startRefinement,
  stopRefinement,
  acceptAnnotation,
  dismissAnnotation,
  toggleKindVisibility,
  UNKINDED_COLOR,
  state
} from '../state/store.js'
import { interactionMode, toggleInteractionMode } from '../state/interaction.js'

/** Glyph per shape — structure at a glance, independent of kind */
const SHAPE_ICONS: Record<string, string> = {
  region: '⬡',
  polyline: '→',
  point: '•'
}

const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
  proposed: { label: 'Proposed', cls: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' },
  stale: { label: 'Stale', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  dismissed: { label: 'Dismissed', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-400' }
}

const UNKINDED_LABEL = 'unkinded'

// ── Refinement chat ──────────────────────────────────────────────────────────

const RefinementChat: Component<{ annotationId: string }> = (props) => {
  const [input, setInput] = createSignal('')

  const handleSend = () => {
    const msg = input().trim()
    if (!msg) return
    setInput('')
    void sendRefinement(props.annotationId, msg)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const annotation = () => state.annotations.find((a) => a.id === props.annotationId)

  return (
    <div class="flex flex-col border border-purple-200 dark:border-purple-800 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-900/50">
      <div class="flex items-center justify-between px-3 py-1.5 bg-purple-50 dark:bg-purple-950/30 border-b border-purple-200 dark:border-purple-800">
        <span class="text-xs font-semibold text-purple-700 dark:text-purple-300">
          Refine: {annotation()?.label ?? '…'}
        </span>
        <button
          class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          onClick={() => stopRefinement()}
        >
          ✕
        </button>
      </div>

      <div class="max-h-48 overflow-y-auto px-3 py-2 space-y-2">
        <Show when={state.conversation?.turns}>
          <For each={state.conversation!.turns}>
            {(turn: ConversationTurn) => (
              <div
                class={`text-xs px-2 py-1.5 rounded ${
                  turn.role === 'user'
                    ? "bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-200 ml-4"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 mr-4"
                }`}
              >
                <div class="font-medium text-[10px] uppercase mb-0.5 opacity-60">
                  {turn.role === 'user' ? 'You' : 'AI'}
                </div>
                <div class="whitespace-pre-wrap">{turn.content.slice(0, 500)}</div>
              </div>
            )}
          </For>
        </Show>
        <Show when={!state.conversation?.turns?.length}>
          <div class="text-[10px] text-gray-400 text-center py-2">
            Type a refinement message to steer the annotation.
          </div>
        </Show>
      </div>

      <div class="flex border-t border-purple-200 dark:border-purple-800">
        <textarea
          class="flex-1 text-xs px-3 py-2 bg-transparent border-none outline-none resize-none"
          rows={2}
          placeholder="Refine this annotation…"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={state.isRefining}
        />
        <button
          class="px-3 text-xs font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 disabled:opacity-50"
          onClick={handleSend}
          disabled={state.isRefining || !input().trim()}
        >
          {state.isRefining ? '…' : 'Send'}
        </button>
      </div>

      <div class="flex gap-1 px-3 py-1.5 border-t border-purple-200 dark:border-purple-800">
        <button
          class="text-[10px] px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200"
          onClick={() => void acceptAnnotation(props.annotationId)}
        >
          Accept
        </button>
        <button
          class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 ml-auto"
          onClick={() => void dismissAnnotation(props.annotationId)}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

// ── Suggest form ─────────────────────────────────────────────────────────────

const SuggestForm: Component = () => {
  const [label, setLabel] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [expanded, setExpanded] = createSignal(false)
  const [discovering, setDiscovering] = createSignal(false)

  const handleExpand = async () => {
    setExpanded(true)
    if (state.availableProviders.length === 0) {
      setDiscovering(true)
      await loadProviders()
      setDiscovering(false)
    }
  }

  const hasRealProvider = () => state.availableProviders.some((p) => p.type !== 'test')
  const canSubmit = () =>
    label().trim().length > 0 &&
    prompt().trim().length > 0 &&
    state.suggestingIds.length === 0 &&
    state.selectedProvider !== null &&
    !discovering()

  const handleSubmit = () => {
    const l = label().trim()
    const p = prompt().trim()
    if (!l || !p) return
    void requestSuggest(l, p)
    setLabel('')
    setPrompt('')
    setExpanded(false)
  }

  return (
    <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <Show
        when={expanded()}
        fallback={
          <button
            class="text-xs text-purple-600 dark:text-purple-400 hover:underline flex items-center gap-1"
            onClick={() => void handleExpand()}
          >
            <span class="text-base leading-none">✦</span> AI Suggest
          </button>
        }
      >
        <div class="space-y-1.5">
          <input
            class="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-transparent"
            placeholder="Label (e.g. Auth Flow)"
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
          <textarea
            class="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-transparent resize-none"
            rows={2}
            placeholder="Describe what to annotate…"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />

          <Show
            when={!discovering()}
            fallback={<div class="text-[10px] text-gray-400 animate-pulse">Discovering providers…</div>}
          >
            <Show when={state.availableProviders.length > 0}>
              <select
                class="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-transparent dark:bg-gray-900"
                value={state.selectedProvider ?? ''}
                onChange={(e) => setSelectedProvider(e.currentTarget.value)}
              >
                <For each={state.availableProviders}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              </select>
            </Show>
            <Show when={!hasRealProvider() && state.availableProviders.length > 0}>
              <div class="text-[10px] text-amber-500">No AI backend detected — only the test provider available.</div>
            </Show>
          </Show>

          <div class="flex gap-1">
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
              onClick={handleSubmit}
              disabled={!canSubmit()}
            >
              {state.suggestingIds.length > 0 ? 'Processing…' : 'Suggest'}
            </button>
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </button>
            <button
              class="text-[10px] px-1.5 py-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-auto"
              onClick={() => void loadProviders()}
              title="Re-scan for providers"
            >
              ↻
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Annotation row ───────────────────────────────────────────────────────────

const AnnotationRow: Component<{ annotation: Annotation }> = (props) => {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal('')

  const selected = () => state.selectedAnnotationId === props.annotation.id
  const refining = () => state.refiningAnnotationId === props.annotation.id
  const badge = () => STATUS_BADGES[props.annotation.status]

  const startEdit = (e: MouseEvent) => {
    e.stopPropagation()
    setDraft(props.annotation.label)
    setEditing(true)
  }

  const commitEdit = () => {
    const next = draft().trim()
    if (next && next !== props.annotation.label) {
      void patchAnnotation(props.annotation.id, { label: next })
    }
    setEditing(false)
  }

  return (
    <div
      class={`group pl-6 pr-2 py-1 cursor-pointer border-l-2 transition-colors text-xs ${
        selected()
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-transparent hover:bg-gray-50 dark:hover:bg-gray-900/50"
      }`}
      data-testid={`annotation-row-${props.annotation.id}`}
      onClick={() => selectAnnotation(selected() ? null : props.annotation.id)}
    >
      <div class="flex items-center gap-1.5">
        <span class="opacity-50 w-3 flex-shrink-0 text-center">{SHAPE_ICONS[props.annotation.shape] ?? '•'}</span>

        <Show
          when={editing()}
          fallback={
            <span
              class="truncate flex-1 text-gray-800 dark:text-gray-200"
              onDblClick={startEdit}
              title={props.annotation.description || props.annotation.label}
            >
              {props.annotation.label || '(untitled)'}
            </span>
          }
        >
          <input
            class="flex-1 min-w-0 bg-white dark:bg-gray-800 border border-blue-400 rounded px-1 outline-none"
            value={draft()}
            autofocus
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        </Show>

        <Show when={props.annotation.members.length > 0}>
          <span class="text-[10px] text-gray-400 flex-shrink-0">{props.annotation.members.length}</span>
        </Show>

        <Show when={props.annotation.status !== 'active'}>
          <span class={`text-[9px] px-1 rounded flex-shrink-0 ${badge()?.cls ?? ''}`}>{badge()?.label}</span>
        </Show>

        <div class="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
          <Show when={props.annotation.status === 'proposed'}>
            <button
              class="text-[10px] text-purple-500 hover:text-purple-700 px-0.5"
              title="Refine with AI"
              onClick={(e) => {
                e.stopPropagation()
                void startRefinement(props.annotation.id)
              }}
            >
              ✦
            </button>
          </Show>
          <button
            class="text-[10px] text-gray-400 hover:text-red-500 px-0.5"
            title="Delete"
            data-testid={`annotation-delete-${props.annotation.id}`}
            onClick={(e) => {
              e.stopPropagation()
              void removeAnnotation(props.annotation.id)
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <Show when={refining()}>
        <div class="mt-1.5 mb-1" onClick={(e) => e.stopPropagation()}>
          <RefinementChat annotationId={props.annotation.id} />
        </div>
      </Show>
    </div>
  )
}

// ── Kind group ───────────────────────────────────────────────────────────────

const KindGroup: Component<{ kind: string; annotations: Annotation[] }> = (props) => {
  const [collapsed, setCollapsed] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [draft, setDraft] = createSignal('')

  const isUnkinded = () => props.kind === ''
  const displayName = () => (isUnkinded() ? UNKINDED_LABEL : props.kind)
  const color = () => (isUnkinded() ? UNKINDED_COLOR : kindColor(props.kind))
  const hidden = () => state.hiddenKinds.includes(props.kind)

  const commitRename = () => {
    const next = draft().trim()
    if (next && next !== props.kind) void renameKind(props.kind, next)
    setRenaming(false)
  }

  return (
    <div data-testid={`kind-group-${displayName()}`}>
      {/* Group header */}
      <div
        class="group flex items-center gap-1.5 px-2 py-1 cursor-pointer select-none
               hover:bg-gray-100 dark:hover:bg-gray-800/60"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span class="text-[9px] text-gray-400 w-2 flex-shrink-0">{collapsed() ? '▸' : '▾'}</span>

        <Show when={!isUnkinded()}>
          <input
            type="color"
            class="w-3 h-3 rounded-full border-none bg-transparent cursor-pointer flex-shrink-0 p-0"
            value={color()}
            title="Change colour"
            data-testid={`kind-color-${props.kind}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => void recolorKind(props.kind, e.currentTarget.value)}
          />
        </Show>
        <Show when={isUnkinded()}>
          <span class="inline-block w-3 h-3 rounded-full flex-shrink-0" style={{ 'background-color': color() }} />
        </Show>

        <Show
          when={renaming()}
          fallback={
            <span
              class={`text-xs font-medium flex-1 truncate ${
                hidden() ? "text-gray-400 line-through" : "text-gray-700 dark:text-gray-200"
              }`}
              onDblClick={(e) => {
                e.stopPropagation()
                if (isUnkinded()) return
                setDraft(props.kind)
                setRenaming(true)
              }}
            >
              {displayName()}
            </span>
          }
        >
          <input
            class="flex-1 min-w-0 text-xs bg-white dark:bg-gray-800 border border-blue-400 rounded px-1 outline-none"
            value={draft()}
            autofocus
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        </Show>

        <span class="text-[10px] text-gray-400 flex-shrink-0">{props.annotations.length}</span>

        <div class="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
          <button
            class="text-[10px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-0.5"
            title={hidden() ? 'Show on canvas' : 'Hide from canvas'}
            data-testid={`kind-visibility-${displayName()}`}
            onClick={(e) => {
              e.stopPropagation()
              toggleKindVisibility(props.kind)
            }}
          >
            {hidden() ? '◌' : '◉'}
          </button>
          <Show when={!isUnkinded()}>
            <button
              class="text-[10px] text-gray-400 hover:text-red-500 px-0.5"
              title="Remove kind from registry (annotations keep the name)"
              onClick={(e) => {
                e.stopPropagation()
                void removeKind(props.kind)
              }}
            >
              ✕
            </button>
          </Show>
        </div>
      </div>

      <Show when={!collapsed()}>
        <For each={props.annotations}>{(ann) => <AnnotationRow annotation={ann} />}</For>
      </Show>
    </div>
  )
}

// ── Panel root ───────────────────────────────────────────────────────────────

export const AnnotationPanel: Component = () => {
  const [filter, setFilter] = createSignal('')

  const visible = createMemo(() => state.annotations.filter((a) => a.status !== 'dismissed'))

  /** Group by kind, sorted with named kinds first and unkinded last. */
  const groups = createMemo(() => {
    const q = filter().trim().toLowerCase()
    const matching = q
      ? visible().filter((a) => a.label.toLowerCase().includes(q) || a.kind.toLowerCase().includes(q))
      : visible()

    const byKind = new Map<string, Annotation[]>()
    for (const ann of matching) {
      const list = byKind.get(ann.kind)
      if (list) list.push(ann)
      else byKind.set(ann.kind, [ann])
    }

    return [...byKind.entries()]
      .sort(([a], [b]) => {
        if (a === '') return 1
        if (b === '') return -1
        return a.localeCompare(b)
      })
      .map(([kind, annotations]) => ({ kind, annotations }))
  })

  const annotating = () => interactionMode() === 'annotate'

  return (
    <div class="flex flex-col h-full text-sm" data-testid="annotation-panel">
      {/* Header */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800">
        <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Annotations</span>
        <span class="text-[10px] text-gray-400">{visible().length}</span>
        <button
          class={`ml-auto text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
            annotating()
              ? "bg-blue-600 text-white"
              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
          }`}
          data-testid="annotate-toggle"
          title="Draw an annotation (A)"
          onClick={() => toggleInteractionMode('annotate')}
        >
          {annotating() ? 'Drawing…' : '✎ Draw'}
        </button>
      </div>

      <SuggestForm />

      {/* Filter */}
      <div class="px-3 py-1.5 border-b border-gray-200 dark:border-gray-800">
        <input
          class="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-transparent"
          placeholder="Filter annotations…"
          value={filter()}
          data-testid="annotation-filter"
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>

      {/* Hidden-kind notice */}
      <Show when={state.hiddenKinds.length > 0}>
        <button
          class="px-3 py-1 text-[10px] text-left text-amber-600 dark:text-amber-400 hover:underline
                 border-b border-gray-200 dark:border-gray-800"
          onClick={() => showAllKinds()}
        >
          {state.hiddenKinds.length} kind{state.hiddenKinds.length !== 1 ? 's' : ''} hidden — show all
        </button>
      </Show>

      {/* Outline */}
      <div class="flex-1 overflow-y-auto py-1">
        <Show
          when={groups().length > 0}
          fallback={
            <div class="px-3 py-6 text-xs text-gray-400 text-center leading-relaxed">
              <Show when={visible().length === 0} fallback={<>No annotations match the filter.</>}>
                No annotations yet.
                <br />
                <span class="text-[11px]">
                  Press <kbd class="px-1 rounded bg-gray-100 dark:bg-gray-800">A</kbd> then drag on the canvas.
                </span>
              </Show>
            </div>
          }
        >
          <For each={groups()}>{(g) => <KindGroup kind={g.kind} annotations={g.annotations} />}</For>
        </Show>
      </div>

      {/* Error */}
      <Show when={state.annotationError}>
        {(msg) => (
          <div class="px-3 py-1.5 text-[10px] text-red-600 dark:text-red-400 border-t border-gray-200 dark:border-gray-800">
            {msg()}
          </div>
        )}
      </Show>
    </div>
  )
}
