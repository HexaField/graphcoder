import { onMount, Show } from 'solid-js'
import { GraphCanvas } from './canvas/GraphCanvas.js'
import { FilterPanel } from './components/FilterPanel.js'
import { NodeInspector } from './components/NodeInspector.js'
import { Toolbar } from './components/Toolbar.js'
import { connectWebSocket, initFromUrl, state } from './state/store.js'

export default function App() {
  onMount(() => {
    connectWebSocket()
    void initFromUrl()
  })

  return (
    <div class="flex flex-col h-screen bg-gray-950 text-white" data-testid="app">
      <Toolbar />
      <Show when={state.error}>{(err) => <div class="bg-red-900 text-red-200 px-4 py-2 text-sm">{err()}</div>}</Show>
      <div class="flex flex-1 overflow-hidden">
        <FilterPanel />
        <GraphCanvas />
        <Show when={state.selectedNodeId}>
          <NodeInspector />
        </Show>
      </div>
    </div>
  )
}
