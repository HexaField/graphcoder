/**
 * GitGraph — SVG-based Git DAG replacing the old dropdown-based GitBar.
 *
 * Shows branches as expandable rows. Each branch displays its tip commit;
 * expanding reveals the full commit chain with parent-child edges drawn as
 * SVG paths. Users click two commits to select base and target for diffing.
 *
 * Layout:
 *   - Each branch occupies a lane (column).
 *   - Commits stack vertically (newest at top).
 *   - Merge edges curve between lanes.
 */
import type { Component } from 'solid-js'
import { createMemo, For, Show } from 'solid-js'
import type { BranchRef, GraphCommit } from '../api/git.js'
import {
  clearGraphSelection,
  runTemporalDiff,
  selectCommit,
  state,
  swapRefs,
  toggleBranchExpanded
} from '../state/store.js'

// ── Layout constants ─────────────────────────────────────────────────────────

const ROW_H = 28
const LANE_W = 16
const DOT_R = 4
const LEFT_PAD = 12

// ── Lane colours ─────────────────────────────────────────────────────────────

const LANE_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16' // lime
]

function laneColor(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length]!
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortMsg(msg: string, max = 50): string {
  return msg.length > max ? msg.slice(0, max - 1) + '…' : msg
}

// ── Types ────────────────────────────────────────────────────────────────────

interface LayoutRow {
  commit: GraphCommit
  lane: number
  y: number
  branchName: string | null
}

// ── Component ────────────────────────────────────────────────────────────────

export const GitGraph: Component = () => {
  const graph = () => state.gitGraph
  const expanded = () => state.expandedBranches

  // Build laid-out rows from graph data + expansion state.
  const layout = createMemo(() => {
    const g = graph()
    if (!g || g.branches.length === 0)
      return {
        rows: [] as LayoutRow[],
        edges: [] as Array<{ x1: number; y1: number; x2: number; y2: number; color: string }>,
        width: 0,
        height: 0,
        laneCount: 0
      }

    const rows: LayoutRow[] = []
    const commitIndex = new Map<string, number>() // hash → row index
    const edges: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = []

    // Assign each branch a lane.
    const branchLanes = new Map<string, number>()
    const sortedBranches = [...g.branches].sort((a, b) => {
      // Current branch first, then alphabetical.
      if (a.current && !b.current) return -1
      if (!a.current && b.current) return 1
      return a.name.localeCompare(b.name)
    })

    sortedBranches.forEach((br, i) => branchLanes.set(br.name, i))
    const laneCount = sortedBranches.length

    // Build a set of commits reachable from each branch, walking parents.
    // For each branch, collect commits in topo order (they're already topo-sorted in g.commits).
    const commitToBranch = new Map<string, string>()

    // First pass: assign each commit to a branch. A commit belongs to the
    // first branch (in our sorted order) whose tip can reach it.
    const branchCommits = new Map<string, GraphCommit[]>()
    const allCommitMap = new Map<string, GraphCommit>()
    for (const c of g.commits) allCommitMap.set(c.hash, c)

    for (const br of sortedBranches) {
      const reachable: GraphCommit[] = []
      const stack = [br.hash]
      const visited = new Set<string>()

      while (stack.length > 0) {
        const h = stack.pop()!
        if (visited.has(h)) continue
        visited.add(h)
        const c = allCommitMap.get(h)
        if (!c) continue
        if (!commitToBranch.has(h)) {
          commitToBranch.set(h, br.name)
          reachable.push(c)
        }
        for (const p of c.parents) stack.push(p)
      }

      branchCommits.set(br.name, reachable)
    }

    // Build rows: for each branch, show the branch header row (tip commit),
    // and if expanded, show subsequent commits.
    let y = 0
    for (const br of sortedBranches) {
      const commits = branchCommits.get(br.name) ?? []
      if (commits.length === 0) continue
      const lane = branchLanes.get(br.name) ?? 0
      const isExpanded = expanded().includes(br.name)

      // Tip commit (always visible).
      const tip = commits[0]!
      rows.push({ commit: tip, lane, y, branchName: br.name })
      commitIndex.set(tip.hash, rows.length - 1)
      y += ROW_H

      if (isExpanded) {
        // Remaining commits on this branch (skip tip).
        for (let i = 1; i < commits.length; i++) {
          const c = commits[i]!
          // Skip if already shown by another branch.
          if (commitIndex.has(c.hash)) continue
          rows.push({ commit: c, lane, y, branchName: null })
          commitIndex.set(c.hash, rows.length - 1)
          y += ROW_H
        }
      }
    }

    // Build edges: parent-child connections between visible commits.
    for (const row of rows) {
      for (const parentHash of row.commit.parents) {
        const parentIdx = commitIndex.get(parentHash)
        if (parentIdx === undefined) continue
        const parentRow = rows[parentIdx]!
        const x1 = LEFT_PAD + row.lane * LANE_W + DOT_R
        const y1 = row.y + ROW_H / 2
        const x2 = LEFT_PAD + parentRow.lane * LANE_W + DOT_R
        const y2 = parentRow.y + ROW_H / 2
        edges.push({ x1, y1, x2, y2, color: laneColor(row.lane) })
      }
    }

    const width = LEFT_PAD + laneCount * LANE_W + DOT_R * 2 + 8
    return { rows, edges, width, height: y, laneCount }
  })

  const canCompare = () => !!(state.baseRef && state.targetRef)

  const compareLabel = () => {
    if (state.isComputing) return state.computeProgress ?? '⟳ Computing…'
    return 'Compare'
  }

  const labelFor = (hash: string | null): string => {
    if (!hash) return '—'
    const g = graph()
    const branch = g?.branches.find((b: BranchRef) => b.hash === hash)
    if (branch) return branch.name
    const commit = g?.commits.find((c: GraphCommit) => c.hash === hash)
    return commit?.shortHash ?? hash.slice(0, 8)
  }

  return (
    <Show when={state.gitBarOpen}>
      <div
        class="flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
        data-testid="git-graph"
      >
        {/* Not a git repo */}
        <Show when={state.isGitRepo === false}>
          <div class="px-4 py-2">
            <span class="text-xs text-gray-400 dark:text-gray-500">This project does not have a Git repository.</span>
          </div>
        </Show>

        {/* Git repo — show graph + controls */}
        <Show when={state.isGitRepo !== false && graph()}>
          {/* Controls bar */}
          <div class="flex items-center gap-3 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
            <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 flex-shrink-0">GIT</span>

            {/* Selection display */}
            <div class="flex items-center gap-1.5 text-xs min-w-0">
              <span
                class={`px-1.5 py-0.5 rounded font-mono ${
                  state.baseRef
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    : "text-gray-400 dark:text-gray-500"
                }`}
              >
                {state.baseRef ? labelFor(state.baseRef) : 'base'}
              </span>

              <button
                class="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-0.5"
                onClick={swapRefs}
                title="Swap base and target"
                disabled={!state.baseRef && !state.targetRef}
              >
                ⇄
              </button>

              <span
                class={`px-1.5 py-0.5 rounded font-mono ${
                  state.targetRef
                    ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300"
                    : "text-gray-400 dark:text-gray-500"
                }`}
              >
                {state.targetRef ? labelFor(state.targetRef) : 'target'}
              </span>
            </div>

            <div class="ml-auto flex items-center gap-2">
              {/* Clear selection */}
              <Show when={state.baseRef || state.targetRef}>
                <button
                  class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white px-2 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                  onClick={clearGraphSelection}
                >
                  Clear
                </button>
              </Show>

              {/* Compare button */}
              <button
                class={`text-xs px-3 py-1 rounded transition-colors ${
                  canCompare() && !state.isComputing
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                }`}
                onClick={() => void runTemporalDiff()}
                disabled={!canCompare() || state.isComputing}
                data-testid="git-compare-btn"
              >
                {compareLabel()}
              </button>
            </div>

            {/* Error display */}
            <Show when={state.diffError}>
              {(err) => (
                <span class="text-xs text-red-500 dark:text-red-400 max-w-xs truncate" title={err()}>
                  {err()}
                </span>
              )}
            </Show>
          </div>

          {/* DAG area */}
          <div class="overflow-auto" style={{ 'max-height': '200px' }}>
            <div class="flex" style={{ 'min-height': `${layout().height}px` }}>
              {/* SVG lane lines + dots */}
              <svg
                width={layout().width}
                height={layout().height}
                class="flex-shrink-0"
                style={{ 'min-width': `${layout().width}px` }}
              >
                {/* Edges */}
                <For each={layout().edges}>
                  {(e) => {
                    if (e.x1 === e.x2) {
                      // Straight vertical line (same lane).
                      return (
                        <line
                          x1={e.x1}
                          y1={e.y1}
                          x2={e.x2}
                          y2={e.y2}
                          stroke={e.color}
                          stroke-width="1.5"
                          opacity="0.5"
                        />
                      )
                    }
                    // Curved merge edge (different lanes).
                    const midY = (e.y1 + e.y2) / 2
                    return (
                      <path
                        d={`M${e.x1},${e.y1} C${e.x1},${midY} ${e.x2},${midY} ${e.x2},${e.y2}`}
                        fill="none"
                        stroke={e.color}
                        stroke-width="1.5"
                        opacity="0.5"
                      />
                    )
                  }}
                </For>

                {/* Commit dots */}
                <For each={layout().rows}>
                  {(row) => {
                    const cx = LEFT_PAD + row.lane * LANE_W + DOT_R
                    const cy = row.y + ROW_H / 2
                    const isBase = () => state.baseRef === row.commit.hash
                    const isTarget = () => state.targetRef === row.commit.hash
                    const isSelected = () => isBase() || isTarget()

                    return (
                      <g style={{ cursor: 'pointer' }} onClick={() => void selectCommit(row.commit.hash)}>
                        {/* Hit area */}
                        <rect
                          x={cx - DOT_R - 4}
                          y={cy - ROW_H / 2}
                          width={DOT_R * 2 + 8}
                          height={ROW_H}
                          fill="transparent"
                        />
                        {/* Selection ring */}
                        <Show when={isSelected()}>
                          <circle
                            cx={cx}
                            cy={cy}
                            r={DOT_R + 3}
                            fill="none"
                            stroke={isBase() ? '#3b82f6' : '#22c55e'}
                            stroke-width="2"
                          />
                        </Show>
                        {/* Dot */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isSelected() ? DOT_R + 1 : DOT_R}
                          fill={isSelected() ? (isBase() ? '#3b82f6' : '#22c55e') : laneColor(row.lane)}
                          stroke={isSelected() ? 'white' : 'none'}
                          stroke-width={isSelected() ? 1 : 0}
                        />
                      </g>
                    )
                  }}
                </For>
              </svg>

              {/* Labels column */}
              <div class="flex-1 min-w-0">
                <For each={layout().rows}>
                  {(row) => {
                    const isBase = () => state.baseRef === row.commit.hash
                    const isTarget = () => state.targetRef === row.commit.hash

                    return (
                      <div
                        class={`flex items-center gap-2 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 select-none ${
                          isBase()
                            ? "bg-blue-50 dark:bg-blue-950/30"
                            : isTarget()
                              ? "bg-green-50 dark:bg-green-950/30"
                              : ''
                        }`}
                        style={{ height: `${ROW_H}px` }}
                        onClick={() => void selectCommit(row.commit.hash)}
                        data-testid={`git-commit-row-${row.commit.shortHash}`}
                      >
                        {/* Branch name (on tip rows) */}
                        <Show when={row.branchName}>
                          {(name) => (
                            <button
                              class={`text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0 transition-colors ${
                                state.currentBranch === name()
                                  ? "bg-blue-600 text-white"
                                  : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleBranchExpanded(name())
                              }}
                              title={expanded().includes(name()) ? `Collapse ${name()}` : `Expand ${name()}`}
                              data-testid={`git-branch-toggle-${name()}`}
                            >
                              {expanded().includes(name()) ? '▾' : '▸'} {name()}
                            </button>
                          )}
                        </Show>

                        {/* Commit hash */}
                        <span class="text-xs font-mono text-gray-400 dark:text-gray-500 flex-shrink-0">
                          {row.commit.shortHash}
                        </span>

                        {/* Commit message */}
                        <span class="text-xs text-gray-600 dark:text-gray-400 truncate min-w-0">
                          {shortMsg(row.commit.message)}
                        </span>

                        {/* Selection badge */}
                        <Show when={isBase()}>
                          <span class="text-[10px] font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0">
                            BASE
                          </span>
                        </Show>
                        <Show when={isTarget()}>
                          <span class="text-[10px] font-semibold text-green-600 dark:text-green-400 flex-shrink-0">
                            TARGET
                          </span>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
