import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import type { Annotation, AnnotationKind, ConversationTurn } from '@graphcoder/core'
import {
  loadAnnotations,
  patchAnnotation,
  removeAnnotation,
  selectAnnotation,
  requestSuggest,
  startRefinement,
  stopRefinement,
  sendRefinement,
  acceptAnnotation,
  dismissAnnotation,
  state
} from '../state/store.js'
import { interactionMode, toggleInteractionMode, MODE_LABELS, type InteractionMode } from '../state/interaction.js'

const KIND_COLORS: Record<AnnotationKind, string> = {
  boundary: 'text-blue-500',
  path: 'text-amber-500',
  note: 'text-emerald-500',
  question: 'text-red-500',
  projection: 'text-violet-500'
}

const KIND_ICONS: Record<AnnotationKind, string> = {
  boundary: '⬡',
  path: '→',
  note: '✎',
  question: '?',
  projection: '◇'
}

const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
  active: { label: 'Active', cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
  proposed: { label: 'Proposed', cls: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' },
  stale: { label: 'Stale', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  dismissed: { label: 'Dismissed', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-400' },
  applied: { label: 'Applied', cls: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' }
}

// ── Refinement Chat ──────────────────────────────────────────────────────────

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

      {/* Conversation turns */}
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

      {/* Input */}
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

      {/* Quick actions */}
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

// ── Suggest Form ─────────────────────────────────────────────────────────────

const SuggestForm: Component = () => {
  const [label, setLabel] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [expanded, setExpanded] = createSignal(false)

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
            onClick={() => setExpanded(true)}
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
          <div class="flex gap-1">
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
              onClick={handleSubmit}
              disabled={!label().trim() || !prompt().trim() || state.suggestingIds.length > 0}
            >
              {state.suggestingIds.length > 0 ? 'Processing…' : 'Suggest'}
            </button>
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Annotation Item ──────────────────────────────────────────────────────────

const ProposedItem: Component<{ annotation: Annotation }> = (props) => {
  const selected = () => state.selectedAnnotationId === props.annotation.id
  const refining = () => state.refiningAnnotationId === props.annotation.id

  return (
    <div
      class={`px-3 py-2 cursor-pointer border-l-2 transition-colors ${
        selected()
          ? "border-purple-500 bg-purple-50 dark:bg-purple-950/30"
          : "border-transparent hover:bg-gray-50 dark:hover:bg-gray-900/50"
      }`}
      onClick={() => selectAnnotation(selected() ? null : props.annotation.id)}
    >
      <div class="flex items-center gap-2">
        <span class={`text-sm font-bold ${KIND_COLORS[props.annotation.kind]}`}>
          {KIND_ICONS[props.annotation.kind]}
        </span>
        <span class="text-sm font-medium truncate flex-1">{props.annotation.label}</span>
        <span class="text-[9px] px-1 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 font-medium">
          AI
        </span>
        <span class={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_BADGES.proposed.cls}`}>Proposed</span>
      </div>
      <Show when={props.annotation.description}>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{props.annotation.description}</div>
      </Show>
      <Show when={props.annotation.reasoning}>
        <div class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 italic truncate">
          {props.annotation.reasoning}
        </div>
      </Show>
      <Show when={selected() && !refining()}>
        <div class="flex gap-1 mt-2">
          <button
            class="text-[10px] px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200"
            onClick={(e) => {
              e.stopPropagation()
              void acceptAnnotation(props.annotation.id)
            }}
          >
            Accept
          </button>
          <button
            class="text-[10px] px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 hover:bg-purple-200"
            onClick={(e) => {
              e.stopPropagation()
              void startRefinement(props.annotation.id)
            }}
          >
            Refine
          </button>
          <button
            class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 ml-auto"
            onClick={(e) => {
              e.stopPropagation()
              void dismissAnnotation(props.annotation.id)
            }}
          >
            Dismiss
          </button>
        </div>
      </Show>
      <Show when={refining()}>
        <div class="mt-2">
          <RefinementChat annotationId={props.annotation.id} />
        </div>
      </Show>
    </div>
  )
}

const AnnotationItem: Component<{ annotation: Annotation }> = (props) => {
  const selected = () => state.selectedAnnotationId === props.annotation.id
  const badge = () => STATUS_BADGES[props.annotation.status] ?? STATUS_BADGES.active

  return (
    <div
      class={`px-3 py-2 cursor-pointer border-l-2 transition-colors ${
        selected()
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-transparent hover:bg-gray-50 dark:hover:bg-gray-900/50"
      }`}
      onClick={() => selectAnnotation(selected() ? null : props.annotation.id)}
    >
      <div class="flex items-center gap-2">
        <span class={`text-sm font-bold ${KIND_COLORS[props.annotation.kind]}`}>
          {KIND_ICONS[props.annotation.kind]}
        </span>
        <span class="text-sm font-medium truncate flex-1">{props.annotation.label}</span>
        <span class={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${badge().cls}`}>{badge().label}</span>
      </div>
      <Show when={props.annotation.description}>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{props.annotation.description}</div>
      </Show>
      <Show when={selected()}>
        <div class="flex gap-1 mt-2">
          <Show when={props.annotation.kind === 'question' && props.annotation.status === 'active'}>
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
              onClick={(e) => {
                e.stopPropagation()
                void patchAnnotation(props.annotation.id, { status: 'resolved' })
              }}
            >
              Resolve
            </button>
            <button
              class="text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.stopPropagation()
                void patchAnnotation(props.annotation.id, { status: 'dismissed' })
              }}
            >
              Dismiss
            </button>
          </Show>
          <button
            class="text-[10px] px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60 ml-auto"
            onClick={(e) => {
              e.stopPropagation()
              void removeAnnotation(props.annotation.id)
            }}
          >
            Delete
          </button>
        </div>
      </Show>
    </div>
  )
}

// ── Mode Button ──────────────────────────────────────────────────────────────

const ModeButton: Component<{ mode: InteractionMode }> = (props) => {
  const active = () => interactionMode() === props.mode
  return (
    <button
      class={`text-xs px-2 py-1 rounded font-medium transition-colors ${
        active()
          ? "bg-blue-600 text-white"
          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
      }`}
      onClick={() => toggleInteractionMode(props.mode)}
    >
      {MODE_LABELS[props.mode]}
    </button>
  )
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export const AnnotationPanel: Component = () => {
  const proposed = createMemo(() => state.annotations.filter((a) => a.status === 'proposed'))

  const grouped = createMemo(() => {
    const byKind: Record<AnnotationKind, Annotation[]> = {
      boundary: [],
      path: [],
      note: [],
      question: [],
      projection: []
    }
    for (const a of state.annotations) {
      if (a.status === 'proposed') continue // shown in PROPOSED section
      byKind[a.kind].push(a)
    }
    return byKind
  })

  const totalCount = () => state.annotations.length

  return (
    <div class="h-full flex flex-col bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Annotations
          <Show when={totalCount() > 0}>
            <span class="ml-1 text-gray-400 dark:text-gray-500">({totalCount()})</span>
          </Show>
        </h2>
        <button class="text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => void loadAnnotations()}>
          Refresh
        </button>
      </div>

      <div class="flex gap-1 px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex-wrap">
        <ModeButton mode="boundary" />
        <ModeButton mode="trace" />
        <ModeButton mode="note" />
        <ModeButton mode="question" />
      </div>

      {/* AI Suggest form */}
      <SuggestForm />

      <div class="flex-1 overflow-y-auto">
        {/* Proposed section */}
        <Show when={proposed().length > 0}>
          <div class="mt-1">
            <div class="text-[10px] uppercase tracking-wider font-semibold px-3 py-1 text-purple-500 flex items-center gap-1">
              <span>✦</span> Proposed ({proposed().length})
            </div>
            <For each={proposed()}>{(ann) => <ProposedItem annotation={ann} />}</For>
          </div>
        </Show>

        <Show when={totalCount() === 0}>
          <div class="text-xs text-gray-400 dark:text-gray-500 px-3 py-6 text-center">
            No annotations yet.{' '}
            <span class="block mt-1">
              Press <kbd class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px]">B</kbd>{' '}
              <kbd class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px]">T</kbd>{' '}
              <kbd class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px]">N</kbd>{' '}
              <kbd class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px]">Q</kbd> to start.
            </span>
          </div>
        </Show>
        <For each={['boundary', 'path', 'note', 'question', 'projection'] as AnnotationKind[]}>
          {(kind) => (
            <Show when={grouped()[kind].length > 0}>
              <div class="mt-1">
                <div class={`text-[10px] uppercase tracking-wider font-semibold px-3 py-1 ${KIND_COLORS[kind]}`}>
                  {kind === 'path' ? 'Paths' : kind === 'boundary' ? 'Boundaries' : kind + 's'}
                </div>
                <For each={grouped()[kind]}>{(ann) => <AnnotationItem annotation={ann} />}</For>
              </div>
            </Show>
          )}
        </For>
      </div>
    </div>
  )
}
