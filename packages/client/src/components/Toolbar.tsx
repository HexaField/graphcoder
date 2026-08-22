import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import type { ViewMode } from '@graphcoder/core'
import { openProject, setViewMode, state } from '../state/store.js'
import { SearchBar } from './SearchBar.js'

// ── Project path input ─────────────────────────────────────────────────────

const ProjectInput: Component = () => {
  const [path, setPath] = createSignal('')

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault()
    const p = path().trim()
    if (p) void openProject(p)
  }

  return (
    <form onSubmit={handleSubmit} class="flex items-center gap-2">
      <input
        type="text"
        placeholder="Project path…"
        class="bg-gray-800 text-white border border-gray-600 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-blue-500"
        data-testid="project-path-input"
        value={path()}
        onInput={(e) => setPath(e.currentTarget.value)}
      />
      <button
        type="submit"
        class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-sm rounded"
        data-testid="open-project-btn"
      >
        Open
      </button>
    </form>
  )
}

// ── View mode switcher ─────────────────────────────────────────────────────

const VIEW_MODES: Array<{ mode: ViewMode; label: string }> = [
  { mode: 'module-dependency', label: 'Module Deps' },
  { mode: 'call-graph', label: 'Call Graph' },
  { mode: 'impact-radius', label: 'Impact Radius' }
]

const ViewModeSwitcher: Component = () => {
  return (
    <div class="flex items-center gap-1">
      <For each={VIEW_MODES}>
        {({ mode, label }) => (
          <button
            class={`px-3 py-1 text-sm rounded ${
              state.viewMode === mode ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
            data-testid={`view-mode-${mode}`}
            onClick={() => void setViewMode(mode)}
          >
            {label}
          </button>
        )}
      </For>
    </div>
  )
}

// ── Toolbar ────────────────────────────────────────────────────────────────

export const Toolbar: Component = () => {
  return (
    <div class="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-700" data-testid="toolbar">
      <span class="text-white font-semibold text-sm">GraphCoder</span>
      <div class="h-4 border-l border-gray-600" />

      <ProjectInput />

      <div class="h-4 border-l border-gray-600" />

      <ViewModeSwitcher />

      <div class="ml-auto">
        <SearchBar />
      </div>

      <Show when={state.projectStats}>
        {(stats) => (
          <div class="text-xs text-gray-400" data-testid="project-stats">
            {stats().nodeCount} nodes · {stats().edgeCount} edges · {stats().fileCount} files
          </div>
        )}
      </Show>
    </div>
  )
}
