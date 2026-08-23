import { createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import type { EdgeKind, NodeKind } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import {
  clearFilters,
  clearFocus,
  setExcludePatterns,
  state,
  toggleEdgeKind,
  toggleGroupByClass,
  toggleGroupByContract,
  toggleGroupByFile,
  toggleGroupByPackage,
  toggleNodeKind
} from '../state/store.js'
import { resolvedTheme } from '../state/theme.js'

// ── Kind chip ─────────────────────────────────────────────────────────────────

interface KindChipProps {
  label: string
  color: string
  isEdge?: boolean
  hidden: boolean
  onToggle: () => void
}

const KindChip: Component<KindChipProps> = (props) => (
  <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
      hover:bg-gray-200 dark:hover:bg-gray-800 transition-opacity ${props.hidden ? 'opacity-30' : 'opacity-100'}`} onClick={props.onToggle} title={props.hidden ? `Show ${props.label}` : `Hide ${props.label}`} data-testid={`filter-kind-${props.label}`}>
    <Show
      when={props.isEdge}
      fallback={<span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: props.color }} />}
    >
      <span
        class="flex-shrink-0"
        style={{ width: '10px', height: '2px', background: props.color, 'border-radius': '1px' }}
      />
    </Show>
    <span class="text-gray-600 dark:text-gray-300 truncate">{props.label}</span>
  </button>
)

// ── Group toggle ──────────────────────────────────────────────────────────────

interface GroupToggleProps {
  label: string
  color: string
  active: boolean
  title: string
  onToggle: () => void
  testId?: string
}

const GroupToggle: Component<GroupToggleProps> = (props) => (
  <button
    class="flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
      hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
    style={
      props.active
        ? {
            'background-color': `${props.color}18`,
            outline: `1px solid ${props.color}80`
          }
        : {}
    }
    onClick={props.onToggle}
    title={props.title}
    data-testid={props.testId}
  >
    <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: props.color }} />
    <span class="text-gray-600 dark:text-gray-300 truncate">{props.label}</span>
  </button>
)

// ── Section heading ───────────────────────────────────────────────────────────

const SectionHead: Component<{ label: string }> = (props) => (
  <div class="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-3 pt-3 pb-1">
    {props.label}
  </div>
)

// ── Graph Parameters Panel ────────────────────────────────────────────────────

export const GraphParamsPanel: Component = () => {
  const isDark = () => resolvedTheme() === 'dark'

  // ── Exclude patterns input — debounced to avoid re-filtering on every keystroke
  const [localPatterns, setLocalPatterns] = createSignal(state.excludePatterns)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  function handlePatternsChange(value: string) {
    setLocalPatterns(value)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setExcludePatterns(value), 300)
  }

  onCleanup(() => clearTimeout(debounceTimer))

  // ── Derived ──────────────────────────────────────────────────────────────────

  const presentNodeKinds = createMemo<NodeKind[]>(() => {
    // Exclude 'import' — import nodes are always elevated to `imports` edges
    const kinds = new Set(state.nodes.filter((n) => n.kind !== 'import').map((n) => n.kind))
    return ([...kinds] as NodeKind[]).sort()
  })

  const presentEdgeKinds = createMemo<EdgeKind[]>(() => {
    const kinds = new Set(state.edges.map((e) => e.kind))
    return ([...kinds] as EdgeKind[]).sort()
  })

  const focusedNode = createMemo(() =>
    state.focusedNodeId ? state.nodes.find((n) => n.id === state.focusedNodeId) : null
  )

  const hasFilters = createMemo(
    () =>
      state.hiddenNodeKinds.length > 0 ||
      state.hiddenEdgeKinds.length > 0 ||
      state.excludePatterns.trim() !== '' ||
      state.groupByFile ||
      state.groupByContract ||
      state.groupByClass ||
      state.groupByPackage
  )

  return (
    <div
      class="w-44 flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col overflow-y-auto"
      data-testid="graph-params-panel"
    >
      {/* ── Header ── */}
      <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-shrink-0">
        <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          Graph Parameters
        </span>
        <Show when={hasFilters()}>
          <button
            class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white"
            onClick={() => {
              clearFilters()
              setLocalPatterns('')
            }}
            title="Reset all parameters"
          >
            clear
          </button>
        </Show>
      </div>

      {/* ── Focus indicator ── */}
      <Show when={focusedNode()}>
        {(node) => (
          <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <div class="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
              Focused
            </div>
            <div class="flex items-start gap-1">
              <span
                class="text-xs font-mono text-blue-600 dark:text-blue-300 break-all leading-tight flex-1"
                title={node().name}
              >
                {node().name}
              </span>
              <button
                class="text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white text-sm leading-none flex-shrink-0 mt-0.5"
                onClick={clearFocus}
                title="Clear focus"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* ── Exclude patterns ── */}
      <div class="border-b border-gray-200 dark:border-gray-700 pb-3">
        <SectionHead label="Exclude" />
        <div class="px-3">
          <textarea
            class="w-full text-xs font-mono bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600
              rounded px-2 py-1.5 text-gray-700 dark:text-gray-300 placeholder-gray-300 dark:placeholder-gray-600
              focus:outline-none focus:ring-1 focus:ring-blue-400 dark:focus:ring-blue-500
              resize-none leading-relaxed"
            rows="2"
            placeholder={'*.test.ts, *.spec.*\n*.stories.tsx'}
            value={localPatterns()}
            onInput={(e) => handlePatternsChange(e.currentTarget.value)}
            title="Comma-separated glob patterns. Use * as a wildcard. Matches against file path."
          />
          <p class="text-[10px] text-gray-400 dark:text-gray-600 mt-1 leading-tight">
            Comma-separated globs, * as wildcard
          </p>
        </div>
      </div>

      {/* ── Group ── */}
      <div class="border-b border-gray-200 dark:border-gray-700 pb-3">
        <SectionHead label="Group" />
        <div class="px-1 flex flex-col gap-0.5">
          <GroupToggle
            label="files"
            color="#0d9488"
            active={state.groupByFile}
            title={state.groupByFile ? 'Disable file grouping' : 'Group nodes by source file'}
            onToggle={toggleGroupByFile}
            testId="filter-scope-group-files"
          />
          <GroupToggle
            label="methods"
            color="#818cf8"
            active={state.groupByClass}
            title={state.groupByClass ? 'Disable method grouping' : 'Group methods and properties under their class'}
            onToggle={toggleGroupByClass}
            testId="filter-scope-group-methods"
          />
          <GroupToggle
            label="contracts"
            color="#f97316"
            active={state.groupByContract}
            title={
              state.groupByContract ? 'Disable contract grouping' : 'Group REST / WebSocket / GraphQL API surfaces'
            }
            onToggle={toggleGroupByContract}
            testId="filter-scope-group-contracts"
          />
          <GroupToggle
            label="packages"
            color="#38bdf8"
            active={state.groupByPackage}
            title={state.groupByPackage ? 'Disable package grouping' : 'Group nodes by monorepo package'}
            onToggle={toggleGroupByPackage}
            testId="filter-scope-group-packages"
          />
        </div>
      </div>

      {/* ── Node types ── */}
      <Show when={presentNodeKinds().length > 0}>
        <div class="border-b border-gray-200 dark:border-gray-700 pb-2">
          <SectionHead label="Nodes" />
          <div class="px-1 flex flex-col gap-0.5">
            <For each={presentNodeKinds()}>
              {(kind) => (
                <KindChip
                  label={kind}
                  color={nodeKindColor(kind, isDark())}
                  hidden={state.hiddenNodeKinds.includes(kind)}
                  onToggle={() => toggleNodeKind(kind)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ── Edge types ── */}
      <Show when={presentEdgeKinds().length > 0}>
        <div class="pb-3">
          <SectionHead label="Links" />
          <div class="px-1 flex flex-col gap-0.5">
            <For each={presentEdgeKinds()}>
              {(kind) => (
                <KindChip
                  label={kind}
                  color={edgeKindColor(kind, isDark())}
                  isEdge
                  hidden={state.hiddenEdgeKinds.includes(kind)}
                  onToggle={() => toggleEdgeKind(kind)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
