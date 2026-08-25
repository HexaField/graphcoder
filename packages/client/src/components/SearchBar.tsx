import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import { search, selectNode, setState, state } from '../state/store.js'

export const SearchBar: Component<{ variant?: string }> = (props) => {
  const testId = (base: string) => (props.variant ? `${base}-${props.variant}` : base)
  return (
    <div class="relative w-full sm:w-auto" data-testid={testId('search-bar')}>
      <input
        type="text"
        placeholder="Search symbols…"
        class="bg-white dark:bg-gray-800 text-gray-900 dark:text-white
          border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm
          w-full sm:w-64 min-w-0
          focus:outline-none focus:border-blue-500
          placeholder-gray-400 dark:placeholder-gray-500"
        data-testid={testId('search-input')}
        value={state.searchQuery}
        onInput={(e) => void search(e.currentTarget.value)}
      />
      <Show when={state.searchResults.length > 0}>
        <div
          class="absolute top-full right-0 sm:left-0 sm:right-auto
            w-full sm:w-80 min-w-[240px]
            bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600
            rounded mt-1 z-50 max-h-64 overflow-auto shadow-lg"
          data-testid={testId('search-results')}
        >
          <For each={state.searchResults}>
            {(result) => (
              <button
                class="w-full text-left px-3 py-2.5 sm:py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                onClick={() => {
                  void selectNode(result.node.id)
                  setState('searchResults', [])
                }}
              >
                <span class="text-xs text-gray-400 dark:text-gray-500 font-mono w-16 shrink-0">{result.node.kind}</span>
                <span class="text-gray-900 dark:text-white text-sm font-mono truncate">{result.node.name}</span>
                <span class="text-gray-400 dark:text-gray-500 text-xs truncate ml-auto">
                  {result.node.filePath.split('/').pop()}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
