/**
 * GitBar — slim history bar between the toolbar and the canvas.
 *
 * Tabs:
 *   Range  — pick two commits on a branch; diff = base → target
 *   Branch — pick a branch; diff = branch tip → HEAD
 *
 * The bar is hidden when `state.gitBarOpen` is false.
 * It is also hidden when the project is not a Git repository.
 */
import type { Component } from 'solid-js'
import { createEffect, For, Show, untrack } from 'solid-js'
import type { CommitInfo } from '../api/git.js'
import {
  loadCommits,
  runTemporalDiff,
  setActiveTab,
  setBaseRef,
  setBranchRef,
  setTargetRef,
  state
} from '../state/store.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shorten a commit message to 60 chars. */
function shortMsg(msg: string): string {
  return msg.length > 60 ? msg.slice(0, 57) + '…' : msg
}

/** Format a commit option label: hash + short message. */
function commitLabel(c: CommitInfo): string {
  return `${c.shortHash}  ${shortMsg(c.message)}`
}

// ── Range tab ─────────────────────────────────────────────────────────────────

const RangeTab: Component = () => {
  const commits = () => state.commits

  // Shared select class
  const selectClass =
    'bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 min-w-0 flex-1'

  return (
    <div class="flex items-center gap-2 min-w-0">
      {/* Branch selector for this tab */}
      <select
        class={selectClass}
        style={{ 'max-width': '140px' }}
        value={state.selectedBranch ?? ''}
        onChange={(e) => void loadCommits(e.currentTarget.value || null)}
        title="Select branch"
      >
        <option value="">HEAD branch</option>
        <For each={state.branches}>{(b) => <option value={b}>{b}</option>}</For>
      </select>

      <span class="text-gray-400 dark:text-gray-500 text-xs flex-shrink-0">from</span>

      {/* Base commit */}
      <select
        class={selectClass}
        value={state.baseRef ?? ''}
        onChange={(e) => setBaseRef(e.currentTarget.value || null)}
        title="Base commit"
        disabled={commits().length === 0}
      >
        <option value="">— base —</option>
        <For each={commits()}>{(c) => <option value={c.hash}>{commitLabel(c)}</option>}</For>
      </select>

      <span class="text-gray-400 dark:text-gray-500 text-xs flex-shrink-0">→</span>

      {/* Target commit */}
      <select
        class={selectClass}
        value={state.targetRef ?? ''}
        onChange={(e) => setTargetRef(e.currentTarget.value || null)}
        title="Target commit"
        disabled={commits().length === 0}
      >
        <option value="">— target —</option>
        <For each={commits()}>{(c) => <option value={c.hash}>{commitLabel(c)}</option>}</For>
      </select>
    </div>
  )
}

// ── Branch tab ────────────────────────────────────────────────────────────────

const BranchTab: Component = () => {
  const selectClass =
    'bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-blue-500'

  return (
    <div class="flex items-center gap-2">
      {/* Branch picker */}
      <select
        class={selectClass}
        style={{ 'max-width': '200px' }}
        value={state.branchRef ?? ''}
        onChange={(e) => setBranchRef(e.currentTarget.value || null)}
        title="Branch to compare against HEAD"
      >
        <option value="">— select branch —</option>
        <For each={state.branches}>
          {(b) => (
            <option value={b} disabled={b === state.currentBranch}>
              {b}
              {b === state.currentBranch ? ' (current)' : ''}
            </option>
          )}
        </For>
      </select>

      <span class="text-gray-400 dark:text-gray-500 text-xs">→ HEAD</span>
    </div>
  )
}

// ── GitBar ────────────────────────────────────────────────────────────────────

export const GitBar: Component = () => {
  // Auto-load commits when the bar opens for the first time.
  //
  // IMPORTANT: commits.length is read via untrack so the effect does NOT
  // subscribe to commits changes. Without untrack, loadCommits() clears
  // commits with setState('commits', []) before the fetch resolves, which
  // fires the effect again — causing an infinite chain of concurrent fetches
  // (thousands of GET /api/git/commits requests that crash the page).
  //
  // The effect only needs to react to gitBarOpen and isGitRepo flipping.
  // Commits are loaded explicitly on branch-change via the onChange handler.
  createEffect(() => {
    if (state.gitBarOpen && state.isGitRepo && untrack(() => state.commits.length) === 0) {
      void loadCommits(null)
    }
  })

  const canCompare = () => {
    if (state.activeTab === 'range') return !!(state.baseRef && state.targetRef)
    return !!state.branchRef
  }

  const compareLabel = () => {
    if (state.isComputing) return state.computeProgress ?? '⟳ Computing…'
    return 'Compare'
  }

  return (
    <Show when={state.gitBarOpen}>
      <div
        class="flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-2"
        data-testid="git-bar"
      >
        {/* Not a git repo */}
        <Show when={state.isGitRepo === false}>
          <span class="text-xs text-gray-400 dark:text-gray-500">This project does not have a Git repository.</span>
        </Show>

        {/* Git repo — show controls */}
        <Show when={state.isGitRepo !== false}>
          <div class="flex items-center gap-3 min-w-0">
            {/* Tab strip */}
            <div class="flex items-center gap-0.5 rounded border border-gray-200 dark:border-gray-700 overflow-hidden flex-shrink-0">
              <button
                class={`px-2.5 py-0.5 text-xs transition-colors ${
                  state.activeTab === 'range'
                    ? "bg-blue-600 text-white"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white"
                }`}
                onClick={() => setActiveTab('range')}
                title="Compare two commits"
                data-testid="git-tab-range"
              >
                Range
              </button>
              <button
                class={`px-2.5 py-0.5 text-xs transition-colors ${
                  state.activeTab === 'branch'
                    ? "bg-blue-600 text-white"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white"
                }`}
                onClick={() => setActiveTab('branch')}
                title="Compare branch against HEAD"
                data-testid="git-tab-branch"
              >
                Branch
              </button>
            </div>

            <div class="h-4 border-l border-gray-300 dark:border-gray-600 flex-shrink-0" />

            {/* Tab content */}
            <div class="min-w-0 flex-1">
              <Show when={state.activeTab === 'range'} fallback={<BranchTab />}>
                <RangeTab />
              </Show>
            </div>

            <div class="h-4 border-l border-gray-300 dark:border-gray-600 flex-shrink-0" />

            {/* Compare button */}
            <button
              class={`flex-shrink-0 text-xs px-3 py-1 rounded transition-colors ${
                canCompare() && !state.isComputing
                  ? "bg-blue-600 hover:bg-blue-700 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
              }`}
              onClick={() => void runTemporalDiff(state.projectRoot)}
              disabled={!canCompare() || state.isComputing}
              data-testid="git-compare-btn"
            >
              {compareLabel()}
            </button>

            {/* Error display */}
            <Show when={state.diffError}>
              {(err) => (
                <span class="text-xs text-red-500 dark:text-red-400 max-w-xs truncate" title={err()}>
                  {err()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
