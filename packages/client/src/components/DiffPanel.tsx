import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { ArchOp } from '@graphcoder/core'
import { clearDiff, state } from '../state/store.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function opLabel(op: ArchOp): string {
  switch (op.op) {
    case 'add_node':
      return `+ ${op.node.kind} ${op.node.name}  (${op.node.filePath})`
    case 'remove_node':
      return `− ${op.node.kind} ${op.node.name}  (${op.node.filePath})`
    case 'modify_node':
      return `~ ${op.id.slice(0, 8)}…  fields: ${Object.keys(op.next).join(', ')}`
    case 'move_node':
      return `→ ${op.id.slice(0, 8)}…  ${op.from.filePath} → ${op.to.filePath}`
    case 'add_edge':
      return `+ edge ${op.edge.kind}  ${op.edge.source.slice(0, 8)}… → ${op.edge.target.slice(0, 8)}…`
    case 'remove_edge':
      return `− edge ${op.edge.kind}  ${op.edge.source.slice(0, 8)}… → ${op.edge.target.slice(0, 8)}…`
  }
}

function opColor(op: ArchOp): string {
  switch (op.op) {
    case 'add_node':
    case 'add_edge':
      return 'text-green-400'
    case 'remove_node':
    case 'remove_edge':
      return 'text-red-400'
    case 'modify_node':
      return 'text-amber-400'
    case 'move_node':
      return 'text-cyan-400'
  }
}

// ── Summary counts ────────────────────────────────────────────────────────────

interface DiffSummary {
  added: number
  removed: number
  modified: number
  moved: number
  edgesAdded: number
  edgesRemoved: number
}

// ── DiffPanel ────────────────────────────────────────────────────────────────

export const DiffPanel: Component = () => {
  const [expanded, setExpanded] = createSignal(true)

  const diff = () => state.currentDiff

  const summary = createMemo((): DiffSummary => {
    const d = diff()
    if (!d) return { added: 0, removed: 0, modified: 0, moved: 0, edgesAdded: 0, edgesRemoved: 0 }
    let added = 0,
      removed = 0,
      modified = 0,
      moved = 0,
      edgesAdded = 0,
      edgesRemoved = 0
    for (const op of d.operations) {
      if (op.op === 'add_node') added++
      else if (op.op === 'remove_node') removed++
      else if (op.op === 'modify_node') modified++
      else if (op.op === 'move_node') moved++
      else if (op.op === 'add_edge') edgesAdded++
      else if (op.op === 'remove_edge') edgesRemoved++
    }
    return { added, removed, modified, moved, edgesAdded, edgesRemoved }
  })

  return (
    <Show when={diff()}>
      <div
        class="flex-shrink-0 bg-gray-900 border-t border-gray-700 flex flex-col"
        style={{ 'max-height': expanded() ? '192px' : '36px' }}
        data-testid="diff-panel"
      >
        {/* Summary bar */}
        <div class="flex items-center gap-3 px-3 py-1.5 border-b border-gray-700 flex-shrink-0">
          <span class="text-xs font-semibold text-gray-300 mr-1">DIFF</span>

          <Show when={summary().added > 0}>
            <span class="text-xs text-green-400">+{summary().added} added</span>
          </Show>
          <Show when={summary().removed > 0}>
            <span class="text-xs text-red-400">−{summary().removed} removed</span>
          </Show>
          <Show when={summary().modified > 0}>
            <span class="text-xs text-amber-400">~{summary().modified} modified</span>
          </Show>
          <Show when={summary().moved > 0}>
            <span class="text-xs text-cyan-400">→{summary().moved} moved</span>
          </Show>
          <Show when={summary().edgesAdded > 0}>
            <span class="text-xs text-green-400">+{summary().edgesAdded} edges</span>
          </Show>
          <Show when={summary().edgesRemoved > 0}>
            <span class="text-xs text-red-400">−{summary().edgesRemoved} edges</span>
          </Show>

          <div class="ml-auto flex items-center gap-2">
            <button
              class="text-xs text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-gray-700"
              onClick={() => setExpanded((v) => !v)}
              data-testid="diff-toggle"
            >
              {expanded() ? '▾ collapse' : '▸ expand'}
            </button>
            <button
              class="text-xs text-gray-400 hover:text-red-400 px-2 py-0.5 rounded hover:bg-gray-800"
              onClick={clearDiff}
              data-testid="clear-diff-btn"
            >
              ✕ clear
            </button>
          </div>
        </div>

        {/* Operations list */}
        <Show when={expanded()}>
          <div class="overflow-y-auto flex-1 px-3 py-1" data-testid="diff-op-list">
            <For each={diff()?.operations ?? []}>
              {(op) => <div class={`text-xs font-mono py-0.5 ${opColor(op)}`}>{opLabel(op)}</div>}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
