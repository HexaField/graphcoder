import type { Component } from 'solid-js'
import { createSignal, Show } from 'solid-js'
import { clearFocus, clearSelection, setFocus, state } from '../state/store.js'

// ── NodeInspector (bottom panel) ──────────────────────────────────────────────

/**
 * Displays detail for the selected node in a collapsible horizontal strip at
 * the bottom of the canvas column. Metadata occupies the left third; source
 * code occupies the right two thirds.
 */
export const NodeInspector: Component = () => {
  const [collapsed, setCollapsed] = createSignal(false)

  return (
    <div
      class="flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex flex-col"
      style={{ height: collapsed() ? '28px' : '13rem' }}
      data-testid="node-inspector"
    >
      <Show
        when={state.selectedNodeDetail}
        fallback={
          /* Loading state — still show the header strip so the panel doesn't jump */
          <div class="flex items-center h-7 px-3 gap-2 flex-shrink-0 border-b border-gray-200 dark:border-gray-700">
            <Show when={state.isLoadingDetail}>
              <span class="text-xs text-gray-400 dark:text-gray-500">Loading…</span>
            </Show>
            <div class="ml-auto flex items-center gap-1">
              <button
                class="text-xs px-1.5 py-0.5 rounded text-gray-400 dark:text-gray-500
                  hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                onClick={() => setCollapsed((v) => !v)}
                title={collapsed() ? 'Expand' : 'Collapse'}
              >
                {collapsed() ? '▸' : '▾'}
              </button>
              <button
                class="text-xs px-1.5 py-0.5 rounded text-gray-400 dark:text-gray-500
                  hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                onClick={clearSelection}
                title="Close inspector"
              >
                ✕
              </button>
            </div>
          </div>
        }
      >
        {(detail) => (
          <>
            {/* ── Header row ── */}
            <div class="flex items-center gap-2 h-7 px-3 flex-shrink-0 border-b border-gray-200 dark:border-gray-700 min-w-0">
              <span class="text-xs font-mono text-gray-400 dark:text-gray-500 flex-shrink-0">{detail().node.kind}</span>
              <span class="text-xs font-mono font-semibold text-gray-900 dark:text-white truncate">
                {detail().node.name}
              </span>
              <Show when={detail().node.filePath}>
                <span class="text-xs font-mono text-gray-400 dark:text-gray-500 truncate hidden sm:block">
                  {detail().node.filePath}
                  <Show when={detail().node.startLine}>:{detail().node.startLine}</Show>
                </span>
              </Show>

              <div class="ml-auto flex items-center gap-1 flex-shrink-0">
                {/* Focus toggle */}
                <button
                  class={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    state.focusedNodeId === detail().node.id
                      ? "bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
                      : "border-gray-300 dark:border-gray-600 text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                  onClick={() => (state.focusedNodeId === detail().node.id ? clearFocus() : setFocus(detail().node.id))}
                  title={state.focusedNodeId === detail().node.id ? 'Clear focus' : 'Focus on neighbours'}
                >
                  {state.focusedNodeId === detail().node.id ? 'Unfocus' : 'Focus'}
                </button>

                <button
                  class="text-xs px-1.5 py-0.5 rounded text-gray-400 dark:text-gray-500
                    hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                  onClick={() => setCollapsed((v) => !v)}
                  title={collapsed() ? 'Expand' : 'Collapse'}
                >
                  {collapsed() ? '▸' : '▾'}
                </button>
                <button
                  class="text-xs px-1.5 py-0.5 rounded text-gray-400 dark:text-gray-500
                    hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                  onClick={clearSelection}
                  title="Close inspector"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* ── Body (two columns) ── */}
            <Show when={!collapsed()}>
              <div class="flex flex-1 overflow-hidden min-h-0">
                {/* Left — metadata */}
                <div class="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 overflow-y-auto px-3 py-2 flex flex-col gap-2">
                  <Show when={detail().node.signature}>
                    <div>
                      <div class="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-0.5">
                        Signature
                      </div>
                      <pre class="text-xs font-mono text-green-600 dark:text-green-400 whitespace-pre-wrap break-all">
                        {detail().node.signature}
                      </pre>
                    </div>
                  </Show>
                  <Show when={detail().node.docstring}>
                    <div>
                      <div class="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-0.5">
                        Docs
                      </div>
                      <p class="text-xs text-gray-700 dark:text-gray-300">{detail().node.docstring}</p>
                    </div>
                  </Show>
                  <div class="text-xs text-gray-400 dark:text-gray-500 mt-auto">
                    {detail().incoming.length} incoming · {detail().outgoing.length} outgoing
                  </div>
                </div>

                {/* Right — source code */}
                <Show when={detail().code}>
                  <div class="flex-1 overflow-auto px-3 py-2" data-testid="code-preview">
                    <pre class="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                      {detail().code}
                    </pre>
                  </div>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
