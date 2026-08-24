/**
 * Temporal state — Git graph DAG and commit-pair diff.
 *
 * The git graph panel shows all branches and commits as a visual DAG.
 * Users click two commits (or branch tips) to select base and target,
 * then compare to compute an ArchDiff between them.
 */
import { computeArchDiff } from '@graphcoder/core'
import type { BranchRef, GitGraph, GitStatus, GraphCommit } from '../api/git.js'
import { computeDiff, fetchGitGraph, fetchGitStatus } from '../api/git.js'
import { setState } from './core.js'

// ── State shape ───────────────────────────────────────────────────────────────

export interface TemporalRange {
  baseLabel: string
  targetLabel: string
}

export interface TemporalState {
  /** Whether the git graph panel is visible. */
  gitBarOpen: boolean
  /** Populated after the first status check; null means unknown. */
  isGitRepo: boolean | null
  currentBranch: string | null
  /** Full DAG data from /api/git/graph. */
  gitGraph: GitGraph | null
  /** Branch names the user has expanded to show commits. */
  expandedBranches: string[]
  /** Selected base commit hash (first click). */
  baseRef: string | null
  /** Selected target commit hash (second click). */
  targetRef: string | null
  /** True while the server computes snapshots / diff. */
  isComputing: boolean
  /** Latest progress message from the server SSE stream. */
  computeProgress: string | null
  /** Set when the last diff computation came from the temporal mapper. */
  temporalRange: TemporalRange | null
  /** Error from the last computation attempt. */
  diffError: string | null
}

// ── Initialise ────────────────────────────────────────────────────────────────

export const temporalInitial: TemporalState = {
  gitBarOpen: false,
  isGitRepo: null,
  currentBranch: null,
  gitGraph: null,
  expandedBranches: [],
  baseRef: null,
  targetRef: null,
  isComputing: false,
  computeProgress: null,
  temporalRange: null,
  diffError: null
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Toggle the git graph panel open/closed. Loads graph data on first open. */
export async function toggleGitBar(): Promise<void> {
  const { state } = await import('./core.js')
  const wasOpen = state.gitBarOpen

  setState('gitBarOpen', (v: boolean) => !v)
  await refreshGitStatus()

  // Load graph data when opening for the first time.
  if (!wasOpen && state.isGitRepo && !state.gitGraph) {
    await loadGitGraph()
  }
}

/** Fetch git status for the current project. */
export async function refreshGitStatus(): Promise<void> {
  let status: GitStatus
  try {
    status = await fetchGitStatus()
  } catch {
    return
  }

  setState('isGitRepo', status.isGitRepo)
  setState('currentBranch', status.currentBranch)
}

/** Load the full git DAG from the server. */
export async function loadGitGraph(): Promise<void> {
  try {
    const graph = await fetchGitGraph(200)
    setState('gitGraph', graph)
  } catch {
    // Non-fatal — graph stays null.
  }
}

/** Toggle a branch's expanded state (show/hide its commits). */
export function toggleBranchExpanded(branchName: string): void {
  setState('expandedBranches', (prev: string[]) =>
    prev.includes(branchName) ? prev.filter((b) => b !== branchName) : [...prev, branchName]
  )
}

/**
 * Handle a commit click. First click sets base, second click sets target.
 * Clicking a selected commit deselects it.
 */
export async function selectCommit(hash: string): Promise<void> {
  const { state } = await import('./core.js')

  if (state.baseRef === hash) {
    setState('baseRef', null)
    return
  }
  if (state.targetRef === hash) {
    setState('targetRef', null)
    return
  }

  if (!state.baseRef) {
    setState('baseRef', hash)
  } else if (!state.targetRef) {
    setState('targetRef', hash)
  } else {
    // Both set — replace target.
    setState('targetRef', hash)
  }
}

/** Swap base and target. */
export function swapRefs(): void {
  // Read current values before mutating.
  // Dynamic import avoids circular dep.
  void import('./core.js').then(({ state }) => {
    const b = state.baseRef
    const t = state.targetRef
    setState('baseRef', t)
    setState('targetRef', b)
  })
}

/** Clear base and target selection. */
export function clearSelection(): void {
  setState('baseRef', null)
  setState('targetRef', null)
}

/**
 * Run the temporal diff between baseRef and targetRef.
 */
export async function runTemporalDiff(): Promise<void> {
  const { state } = await import('./core.js')

  const base = state.baseRef
  const target = state.targetRef

  if (!base || !target) {
    setState('diffError', 'Select two commits to compare.')
    return
  }

  // Build labels from the graph data.
  const graph = state.gitGraph
  const labelFor = (hash: string): string => {
    // Check if a branch tip points here.
    const branch = graph?.branches.find((b: BranchRef) => b.hash === hash)
    if (branch) return branch.name
    // Otherwise use short hash.
    const commit = graph?.commits.find((c: GraphCommit) => c.hash === hash)
    return commit?.shortHash ?? hash.slice(0, 8)
  }

  setState('isComputing', true)
  setState('computeProgress', 'Starting…')
  setState('diffError', null)
  setState('baseSnapshot', null)
  setState('currentDiff', null)

  try {
    const diff = await computeDiff(base, target, (msg) => setState('computeProgress', msg))
    setState('currentDiff', diff)
    setState('temporalRange', { baseLabel: labelFor(base), targetLabel: labelFor(target) })
  } catch (err) {
    setState('diffError', err instanceof Error ? err.message : 'Computation failed')
  } finally {
    setState('isComputing', false)
    setState('computeProgress', null)
  }
}

export { computeArchDiff }
