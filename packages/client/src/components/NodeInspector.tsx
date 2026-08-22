import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import { state } from '../state/store.js'

export const NodeInspector: Component = () => {
  return (
    <div class="w-80 bg-gray-900 border-l border-gray-700 flex flex-col overflow-hidden" data-testid="node-inspector">
      <Show
        when={state.selectedNodeDetail}
        fallback={
          <Show when={state.isLoadingDetail}>
            <div class="p-4 text-gray-400">Loading…</div>
          </Show>
        }
      >
        {(detail) => (
          <>
            <div class="p-4 border-b border-gray-700">
              <div class="text-xs text-gray-500 uppercase mb-1">{detail().node.kind}</div>
              <div class="text-white font-mono font-medium">{detail().node.name}</div>
              <div class="text-gray-400 text-xs mt-1 font-mono truncate">
                {detail().node.filePath}:{detail().node.startLine}
              </div>
            </div>
            <Show when={detail().node.signature}>
              <div class="p-4 border-b border-gray-700">
                <div class="text-xs text-gray-500 mb-1">SIGNATURE</div>
                <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap break-all">
                  {detail().node.signature}
                </pre>
              </div>
            </Show>
            <Show when={detail().node.docstring}>
              <div class="p-4 border-b border-gray-700">
                <div class="text-xs text-gray-500 mb-1">DOCUMENTATION</div>
                <p class="text-gray-300 text-sm">{detail().node.docstring}</p>
              </div>
            </Show>
            <div class="p-4 border-b border-gray-700">
              <div class="text-xs text-gray-500 mb-1">EDGES</div>
              <div class="text-xs text-gray-400">
                {detail().incoming.length} incoming · {detail().outgoing.length} outgoing
              </div>
            </div>
            <Show when={detail().code}>
              <div class="flex-1 overflow-auto p-4" data-testid="code-preview">
                <div class="text-xs text-gray-500 mb-2">SOURCE</div>
                <pre class="text-gray-300 text-xs font-mono whitespace-pre-wrap">{detail().code}</pre>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
