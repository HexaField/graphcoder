import { createEffect, createSignal, onMount, Show } from 'solid-js'
import { GraphCanvas } from './canvas/GraphCanvas.js'
import { DiffPanel } from './components/DiffPanel.js'
import { FilterPanel } from './components/FilterPanel.js'
import { NodeInspector } from './components/NodeInspector.js'
import { Toolbar } from './components/Toolbar.js'
import { connectWebSocket, initFromUrl, state } from './state/store.js'
// Import theme module to ensure the root-level createRoot runs on startup
import './state/theme.js'

// Thin toggle-strip button shared by both drawers
interface DrawerToggleProps {
  side: 'left' | 'right'
  open: boolean
  onToggle: () => void
}

const DrawerToggle = (props: DrawerToggleProps) => {
  // Arrow points inward when open (toward the panel), outward when closed
  const arrow = () => {
    if (props.side === 'left') return props.open ? '‹' : '›'
    return props.open ? '›' : '‹'
  }
  const border = props.side === 'left' ? 'border-r' : 'border-l'
  return (
    <button class={`w-5 flex-shrink-0 bg-gray-100 dark:bg-gray-900 ${border} border-gray-200 dark:border-gray-700
        flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-800
        text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors`} onClick={props.onToggle} title={props.open ? 'Close panel' : 'Open panel'}>
      <span class="text-xs leading-none">{arrow()}</span>
    </button>
  )
}

export default function App() {
  const [filterOpen, setFilterOpen] = createSignal(true)
  const [inspectorOpen, setInspectorOpen] = createSignal(true)

  // Re-open inspector whenever a new node gets selected
  createEffect(() => {
    if (state.selectedNodeId) setInspectorOpen(true)
  })

  onMount(() => {
    connectWebSocket()
    void initFromUrl()
  })

  return (
    <div class="flex flex-col h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white" data-testid="app">
      <Toolbar />
      <Show when={state.error}>
        {(err) => (
          <div class="bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 px-4 py-2 text-sm">{err()}</div>
        )}
      </Show>
      <div class="flex flex-1 overflow-hidden">
        {/* Left drawer — filter panel */}
        <Show when={filterOpen()}>
          <FilterPanel />
        </Show>
        <DrawerToggle side="left" open={filterOpen()} onToggle={() => setFilterOpen((v) => !v)} />

        {/* Main canvas */}
        <GraphCanvas />

        {/* Right drawer — node inspector (only when a node is selected) */}
        <Show when={state.selectedNodeId}>
          <DrawerToggle side="right" open={inspectorOpen()} onToggle={() => setInspectorOpen((v) => !v)} />
          <Show when={inspectorOpen()}>
            <NodeInspector />
          </Show>
        </Show>
      </div>

      {/* Bottom diff panel — only when an active diff exists */}
      <DiffPanel />
    </div>
  )
}
