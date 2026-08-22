import { type Component, createMemo, For, Show } from 'solid-js'
import type { EdgeKind, NodeKind } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import { clearFilters, clearFocus, state, toggleEdgeKind, toggleNodeKind } from '../state/store.js'

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
      hover:bg-gray-800 transition-opacity ${props.hidden ? 'opacity-30' : 'opacity-100'}`} onClick={props.onToggle} title={props.hidden ? `Show ${props.label}` : `Hide ${props.label}`} data-testid={`filter-kind-${props.label}`}>
    <Show
      when={props.isEdge}
      fallback={<span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: props.color }} />}
    >
      <span
        class="flex-shrink-0"
        style={{ width: '10px', height: '2px', background: props.color, 'border-radius': '1px' }}
      />
    </Show>
    <span class="text-gray-300 truncate">{props.label}</span>
  </button>
)

// ── Filter panel ──────────────────────────────────────────────────────────────

export const FilterPanel: Component = () => {
  const presentNodeKinds = createMemo<NodeKind[]>(() => {
    const kinds = new Set(state.nodes.map((n) => n.kind))
    return ([...kinds] as NodeKind[]).sort()
  })

  const presentEdgeKinds = createMemo<EdgeKind[]>(() => {
    const kinds = new Set(state.edges.map((e) => e.kind))
    return ([...kinds] as EdgeKind[]).sort()
  })

  const focusedNode = createMemo(() =>
    state.focusedNodeId ? state.nodes.find((n) => n.id === state.focusedNodeId) : null
  )

  const hasFilters = createMemo(() => state.hiddenNodeKinds.length > 0 || state.hiddenEdgeKinds.length > 0)

  return (
    <div
      class="w-44 flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col overflow-y-auto"
      data-testid="filter-panel"
    >
      {/* Header */}
      <div class="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Filters</span>
        <Show when={hasFilters()}>
          <button class="text-xs text-gray-500 hover:text-white" onClick={clearFilters} title="Clear all filters">
            clear
          </button>
        </Show>
      </div>

      {/* Focus indicator */}
      <Show when={focusedNode()}>
        {(node) => (
          <div class="px-3 py-2 border-b border-gray-700">
            <div class="text-xs text-gray-500 mb-1">FOCUSED</div>
            <div class="flex items-start gap-1">
              <span class="text-xs font-mono text-blue-300 break-all leading-tight flex-1" title={node().name}>
                {node().name}
              </span>
              <button
                class="text-gray-500 hover:text-white text-sm leading-none flex-shrink-0 mt-0.5"
                onClick={clearFocus}
                title="Clear focus"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Node kinds */}
      <Show when={presentNodeKinds().length > 0}>
        <div class="px-3 pt-3 pb-1">
          <div class="text-xs text-gray-500 mb-1.5 uppercase tracking-wider">Nodes</div>
          <div class="flex flex-col gap-0.5">
            <For each={presentNodeKinds()}>
              {(kind) => (
                <KindChip
                  label={kind}
                  color={nodeKindColor(kind)}
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
          <div class="text-xs text-gray-500 mb-1.5 uppercase tracking-wider">Links</div>
          <div class="flex flex-col gap-0.5">
            <For each={presentEdgeKinds()}>
              {(kind) => (
                <KindChip
                  label={kind}
                  color={edgeKindColor(kind)}
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
