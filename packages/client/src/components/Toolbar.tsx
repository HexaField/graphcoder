import type { Component } from 'solid-js'
import { createSignal, Show } from 'solid-js'
import { captureSnapshot, clearDiff, openProject, setGraphDirection, state, toggleGitBar } from '../state/store.js'
import { cycleTheme, theme } from '../state/theme.js'
import { SearchBar } from './SearchBar.js'

// ── Theme toggle ───────────────────────────────────────────────────────────────

const THEME_ICONS = { light: '☀', dark: '◑', system: '⊙' } as const
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'Auto' } as const

const ThemeToggle: Component = () => (
  <button
    class="flex items-center gap-1 text-xs px-2 py-1 rounded border
      border-gray-200 dark:border-gray-700
      text-gray-600 dark:text-gray-400
      hover:bg-gray-100 dark:hover:bg-gray-800
      hover:text-gray-900 dark:hover:text-white transition-colors"
    onClick={cycleTheme}
    title={`Theme: ${THEME_LABELS[theme()]} — click to cycle`}
    data-testid="theme-toggle"
  >
    <span>{THEME_ICONS[theme()]}</span>
    <span class="hidden sm:inline">{THEME_LABELS[theme()]}</span>
  </button>
)

// ── Project path input ─────────────────────────────────────────────────────

const ProjectInput: Component = () => {
  const [path, setPath] = createSignal('')

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault()
    const p = path().trim()
    if (p) void openProject(p)
  }

  return (
    <form onSubmit={handleSubmit} class="flex items-center gap-2 flex-1 sm:flex-none min-w-0">
      <input
        type="text"
        placeholder="Project path…"
        class="bg-white dark:bg-gray-800 text-gray-900 dark:text-white
          border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm
          w-full sm:w-64 min-w-0
          focus:outline-none focus:border-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
        data-testid="project-path-input"
        value={path()}
        onInput={(e) => setPath(e.currentTarget.value)}
      />
      <button
        type="submit"
        class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-sm rounded flex-shrink-0"
        data-testid="open-project-btn"
      >
        Open
      </button>
    </form>
  )
}

// ── Direction toggle ───────────────────────────────────────────────────────

const DirectionToggle: Component = () => (
  <div
    class="flex items-center gap-0.5 rounded border border-gray-200 dark:border-gray-700 overflow-hidden"
    title="Layout direction"
  >
    <button
      class={`px-2.5 py-1 text-sm transition-colors ${
        state.graphDirection === 'TB'
          ? "bg-blue-600 text-white"
          : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
      }`}
      data-testid="direction-tb"
      onClick={() => setGraphDirection('TB')}
      title="Top-to-bottom layout"
    >
      ⇕
    </button>
    <button
      class={`px-2.5 py-1 text-sm transition-colors ${
        state.graphDirection === 'LR'
          ? "bg-blue-600 text-white"
          : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
      }`}
      data-testid="direction-lr"
      onClick={() => setGraphDirection('LR')}
      title="Left-to-right layout"
    >
      ⇔
    </button>
  </div>
)

// ── Toolbar ────────────────────────────────────────────────────────────────

export const Toolbar: Component = () => {
  return (
    <div class="bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700" data-testid="toolbar">
      {/* ── Primary row — always visible ── */}
      <div class="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2">
        <span class="hidden sm:block text-gray-900 dark:text-white font-semibold text-sm flex-shrink-0">
          GraphCoder
        </span>
        <div class="hidden sm:block h-4 border-l border-gray-300 dark:border-gray-600 flex-shrink-0" />

        <ProjectInput />

        {/* Desktop-only: direction + diff controls (hidden on mobile, shown on secondary row) */}
        <div class="hidden sm:flex items-center gap-3">
          <div class="h-4 border-l border-gray-300 dark:border-gray-600" />
          <DirectionToggle />
          <div class="h-4 border-l border-gray-300 dark:border-gray-600" />
          <Show when={state.fileNodes.length > 0}>
            <Show
              when={state.baseSnapshot}
              fallback={
                <button
                  class="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600
                    text-gray-600 dark:text-gray-300
                    hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white"
                  onClick={captureSnapshot}
                  data-testid="snapshot-btn"
                  title="Capture current graph as diff baseline"
                >
                  ⊙ Snapshot
                </button>
              }
            >
              <span class="text-xs text-blue-500 dark:text-blue-400 font-mono">diff active</span>
              <button
                class="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700
                  text-gray-500 dark:text-gray-400
                  hover:text-red-600 dark:hover:text-red-400 hover:border-red-400 dark:hover:border-red-700"
                onClick={clearDiff}
                data-testid="clear-diff-toolbar-btn"
              >
                ✕ Clear diff
              </button>
            </Show>
          </Show>
        </div>

        {/* Right group — search + theme always visible; history desktop-only */}
        <div class="ml-auto flex items-center gap-2 sm:gap-3">
          <Show when={state.fileNodes.length > 0}>
            <button
              class={`hidden sm:flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                state.gitBarOpen
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white"
              }`}
              onClick={() => void toggleGitBar()}
              title="Toggle Git history panel (H)"
              data-testid="git-bar-toggle"
            >
              ⏱ History
            </button>
          </Show>
          <div class="hidden sm:block">
            <SearchBar />
          </div>
          <ThemeToggle />
        </div>

        <Show when={state.projectStats}>
          {(stats) => (
            <div class="hidden sm:block text-xs text-gray-500 dark:text-gray-400" data-testid="project-stats">
              {stats().nodeCount} nodes · {stats().edgeCount} edges · {stats().fileCount} files
            </div>
          )}
        </Show>
      </div>

      {/* ── Secondary row — mobile only ── */}
      <div class="flex sm:hidden items-center gap-2 px-3 pb-2">
        <DirectionToggle />
        <Show when={state.fileNodes.length > 0}>
          <button
            class={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
              state.gitBarOpen
                ? "bg-blue-600 border-blue-600 text-white"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
            }`}
            onClick={() => void toggleGitBar()}
            title="Toggle Git history"
            aria-label="Toggle Git history panel"
          >
            ⏱
          </button>
        </Show>
        <Show when={state.fileNodes.length > 0 && state.baseSnapshot}>
          <span class="text-xs text-blue-500 dark:text-blue-400 font-mono">diff on</span>
        </Show>
        <div class="ml-auto flex-1 max-w-xs">
          <SearchBar />
        </div>
      </div>
    </div>
  )
}
