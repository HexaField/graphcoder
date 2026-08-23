import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import { clearFocus, setFocus, state } from '../state/store.js'

export const NodeInspector: Component = () => {
  return (
    <div
      class="w-80 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden"
      data-testid="node-inspector"
    >
      <Show
        when={state.selectedNodeDetail}
        fallback={
          <Show when={state.isLoadingDetail}>
            <div class="p-4 text-gray-500 dark:text-gray-400">Loading…</div>
          </Show>
        }
      >
        {(detail) => (
          <>
            <div class="p-4 border-b border-gray-200 dark:border-gray-700">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-xs text-gray-400 dark:text-gray-500 uppercase mb-1">{detail().node.kind}</div>
                  <div class="text-gray-900 dark:text-white font-mono font-medium truncate">{detail().node.name}</div>
                  <div class="text-gray-500 dark:text-gray-400 text-xs mt-1 font-mono truncate">
                    {detail().node.filePath}:{detail().node.startLine}
                  </div>
                </div>
                <button
                  class={`flex-shrink-0 text-xs px-2 py-1 rounded border transition-colors ${
                    state.focusedNodeId === detail().node.id
                      ? "bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800"
                      : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-blue-600 dark:text-blue-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                  onClick={() => (state.focusedNodeId === detail().node.id ? clearFocus() : setFocus(detail().node.id))}
                  title={
                    state.focusedNodeId === detail().node.id ? 'Clear focus' : 'Focus on this node and its neighbours'
                  }
                >
                  {state.focusedNodeId === detail().node.id ? 'Unfocus' : 'Focus'}
                </button>
              </div>
            </div>
            <Show when={detail().node.signature}>
              <div class="p-4 border-b border-gray-200 dark:border-gray-700">
                <div class="text-xs text-gray-400 dark:text-gray-500 mb-1">SIGNATURE</div>
                <pre class="text-green-600 dark:text-green-400 text-xs font-mono whitespace-pre-wrap break-all">
                  {detail().node.signature}
                </pre>
              </div>
            </Show>
            <Show when={detail().node.docstring}>
              <div class="p-4 border-b border-gray-200 dark:border-gray-700">
                <div class="text-xs text-gray-400 dark:text-gray-500 mb-1">DOCUMENTATION</div>
                <p class="text-gray-700 dark:text-gray-300 text-sm">{detail().node.docstring}</p>
              </div>
            </Show>
            <div class="p-4 border-b border-gray-200 dark:border-gray-700">
              <div class="text-xs text-gray-400 dark:text-gray-500 mb-1">EDGES</div>
              <div class="text-xs text-gray-600 dark:text-gray-400">
                {detail().incoming.length} incoming · {detail().outgoing.length} outgoing
              </div>
            </div>
            <Show when={detail().code}>
              <div class="flex-1 overflow-auto p-4" data-testid="code-preview">
                <div class="text-xs text-gray-400 dark:text-gray-500 mb-2">SOURCE</div>
                <pre class="text-gray-700 dark:text-gray-300 text-xs font-mono whitespace-pre-wrap">
                  {detail().code}
                </pre>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
