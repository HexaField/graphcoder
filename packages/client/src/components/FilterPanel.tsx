import { type Component, createMemo, For, Show } from 'solid-js'
import type { EdgeKind, NodeKind } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import {
  clearFilters,
  clearFocus,
  state,
  toggleEdgeKind,
  toggleGroupByClass,
  toggleGroupByContract,
  toggleGroupByFile,
  toggleHideDevFiles,
  toggleHideTestFiles,
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

// ── Filter panel ──────────────────────────────────────────────────────────────

export const FilterPanel: Component = () => {
  const isDark = () => resolvedTheme() === 'dark'

  const presentNodeKinds = createMemo<NodeKind[]>(() => {
    // Exclude 'import' — import nodes are always elevated to `imports` edges
    // in visibleGraph() and never appear as visible nodes. They show up in
    // the Links section under 'imports' instead.
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
      state.hideTestFiles ||
      state.hideDevFiles ||
      state.groupByFile ||
      state.groupByContract ||
      state.groupByClass
  )

  return (
    <div
      class="w-44 flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-y-auto"
      data-testid="filter-panel"
    >
      {/* Header */}
      <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Filters</span>
        <Show when={hasFilters()}>
          <button
            class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white"
            onClick={clearFilters}
            title="Clear all filters"
          >
            clear
          </button>
        </Show>
      </div>

      {/* Focus indicator */}
      <Show when={focusedNode()}>
        {(node) => (
          <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <div class="text-xs text-gray-400 dark:text-gray-500 mb-1">FOCUSED</div>
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

      {/* Scope toggles */}
      <div class="px-3 pt-3 pb-2 border-b border-gray-200 dark:border-gray-700">
        <div class="text-xs text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Scope</div>
        <div class="flex flex-col gap-0.5">
          {/* tests — opacity-30 when active (items are filtered out) */}
          <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
              hover:bg-gray-200 dark:hover:bg-gray-800 transition-opacity ${state.hideTestFiles ? 'opacity-30' : 'opacity-100'}`} onClick={toggleHideTestFiles} title={state.hideTestFiles ? 'Show test files' : 'Hide test files'} data-testid="filter-scope-tests">
            <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: '#f59e0b' }} />
            <span class="text-gray-600 dark:text-gray-300 truncate">tests</span>
          </button>

          {/* devops — opacity-30 when active (config/toolchain files filtered out) */}
          <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
              hover:bg-gray-200 dark:hover:bg-gray-800 transition-opacity ${state.hideDevFiles ? 'opacity-30' : 'opacity-100'}`} onClick={toggleHideDevFiles} title={state.hideDevFiles ? 'Show devops files' : 'Hide devops files (config, lock, CI, env…)'} data-testid="filter-scope-devops">
            <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: '#8b5cf6' }} />
            <span class="text-gray-600 dark:text-gray-300 truncate">devops</span>
          </button>

          {/* group files — highlighted when active (feature is ON) */}
          <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
              hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors ${state.groupByFile ? "bg-teal-50 dark:bg-teal-900/20 ring-1 ring-teal-400/60 dark:ring-teal-600/60" : ''}`} onClick={toggleGroupByFile} title={state.groupByFile ? 'Disable file grouping' : 'Group nodes by source file'} data-testid="filter-scope-group-files">
            <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: '#0d9488' }} />
            <span class="text-gray-600 dark:text-gray-300 truncate">group files</span>
          </button>

          {/* group methods — highlighted when active (feature is ON) */}
          <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
              hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors ${state.groupByClass ? "bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-400/60 dark:ring-indigo-600/60" : ''}`} onClick={toggleGroupByClass} title={state.groupByClass ? 'Disable method grouping' : 'Group methods and properties under their parent class'} data-testid="filter-scope-group-methods">
            <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: '#818cf8' }} />
            <span class="text-gray-600 dark:text-gray-300 truncate">group methods</span>
          </button>

          {/* group contracts — highlighted when active (feature is ON) */}
          <button class={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left
              hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors ${state.groupByContract ? "bg-orange-50 dark:bg-orange-900/20 ring-1 ring-orange-400/60 dark:ring-orange-600/60" : ''}`} onClick={toggleGroupByContract} title={state.groupByContract ? 'Disable contract grouping' : 'Group nodes by API surface (REST, WebSocket, GraphQL…)'} data-testid="filter-scope-group-contracts">
            <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: '#f97316' }} />
            <span class="text-gray-600 dark:text-gray-300 truncate">group contracts</span>
          </button>
        </div>
      </div>

      {/* Node kinds */}
      <Show when={presentNodeKinds().length > 0}>
        <div class="px-3 pt-3 pb-1">
          <div class="text-xs text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Nodes</div>
          <div class="flex flex-col gap-0.5">
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

      {/* Edge kinds */}
      <Show when={presentEdgeKinds().length > 0}>
        <div class="px-3 pt-3 pb-3">
          <div class="text-xs text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Links</div>
          <div class="flex flex-col gap-0.5">
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
