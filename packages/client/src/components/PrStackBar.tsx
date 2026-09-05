/**
 * PrStackBar — horizontal bar showing the stacked PR chain.
 *
 * Each PR appears as a coloured segment. Click to highlight that PR's
 * nodes on the graph. ← → keyboard navigation steps through the stack.
 */
import { type Component, createMemo, For, Show } from 'solid-js'
import { state, setActivePr, nextPr, prevPr, clearPrStack, importPrAnnotations } from '../state/store.js'

const PR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1']

export function prColor(index: number): string {
  return PR_COLORS[index % PR_COLORS.length]
}

export const PrStackBar: Component = () => {
  const prs = () => state.prStack.prs
  const active = () => state.prStack.activePrIndex
  const loading = () => state.prStack.loading

  const hasStack = createMemo(() => prs().length > 0)

  return (
    <Show when={hasStack()}>
      <div
        class="flex items-center gap-1 px-2 py-1.5 bg-gray-50 dark:bg-gray-900
               border-t border-gray-200 dark:border-gray-700 text-xs overflow-x-auto flex-shrink-0"
        data-testid="pr-stack-bar"
      >
        {/* Navigation */}
        <button
          class="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-white disabled:opacity-30"
          disabled={active() <= 0}
          onClick={prevPr}
          title="Previous PR (←)"
        >
          ←
        </button>

        {/* PR segments */}
        <div class="flex items-center gap-0.5 flex-1 min-w-0">
          <For each={prs()}>
            {(pr, i) => {
              const isActive = () => i() === active()
              const color = () => prColor(i())
              return (
                <button
                  class="flex items-center gap-1 px-2 py-0.5 rounded font-mono truncate
                         transition-all whitespace-nowrap"
                  classList={{
                    'ring-2 ring-offset-1 dark:ring-offset-gray-900': isActive()
                  }}
                  style={
                    {
                      'background-color': isActive() ? `${color()}30` : 'transparent',
                      color: isActive() ? color() : undefined,
                      '--tw-ring-color': isActive() ? color() : undefined,
                      'border-left': `3px solid ${color()}`
                    } as any
                  }
                  onClick={() => setActivePr(i())}
                  title={`${pr.title}\n+${pr.stats.additions}/-${pr.stats.deletions} across ${pr.files.length} files`}
                  data-testid={`pr-segment-${i()}`}
                >
                  <span class="text-gray-500 dark:text-gray-400">#{pr.index}</span>
                  <span class="truncate max-w-[160px] text-gray-700 dark:text-gray-300">
                    {pr.title.replace(/^feat\([^)]*\):\s*/, '').replace(/^PR\d+\s*[—–-]\s*/, '')}
                  </span>
                  <span class="text-gray-400 dark:text-gray-500 tabular-nums">+{pr.stats.additions}</span>
                </button>
              )
            }}
          </For>
        </div>

        <button
          class="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-white disabled:opacity-30"
          disabled={active() >= prs().length - 1}
          onClick={nextPr}
          title="Next PR (→)"
        >
          →
        </button>

        {/* Actions */}
        <div class="flex items-center gap-1 ml-2 border-l border-gray-200 dark:border-gray-700 pl-2">
          <button
            class="px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400
                   hover:bg-blue-500/20 disabled:opacity-30"
            disabled={loading()}
            onClick={importPrAnnotations}
            title="Import PRs as proposed annotations"
          >
            Import
          </button>
          <button
            class="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-white"
            onClick={clearPrStack}
            title="Close PR stack view"
          >
            ×
          </button>
        </div>
      </div>
    </Show>
  )
}
