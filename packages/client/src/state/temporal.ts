/**
 * Temporal state — Git history bar and commit-range diff.
 *
 * The git bar allows selecting two commits on a branch and computing an
 * ArchDiff between them. The result feeds into the same `currentDiff` field
 * used by the snapshot workflow, but also populates `temporalRange` so the
 * DiffPanel can display the commit range label.
 *
 * Tabs:
 *   range  — pick two commits on the same branch; diff = base → target
 *   branch — pick a branch; diff = branch tip → HEAD (cross-branch)
 */
import { computeArchDiff } from '@graphcoder/core'
import type { CommitInfo, GitStatus } from '../api/git.js'
import { computeDiff, fetchBranches, fetchCommits, fetchGitStatus } from '../api/git.js'
import { setState } from './core.js'

// ── State shape ───────────────────────────────────────────────────────────────

export interface TemporalRange {
  /** Short display label for the base commit (e.g. "abc1234" or branch name). */
  baseLabel: string
  /** Short display label for the target commit. */
  targetLabel: string
}

export interface TemporalState {
  /** Whether the git history bar is visible. */
  gitBarOpen: boolean
  /** Populated after the first status check; null means unknown. */
  isGitRepo: boolean | null
  currentBranch: string | null
  branches: string[]
  commits: CommitInfo[]
  /** Branch currently selected in the branch picker. */
  selectedBranch: string | null
  /** Active tab in the git bar. */
  activeTab: 'range' | 'branch'
  /** Base ref for Range mode (commit hash or 'HEAD'). */
  baseRef: string | null
  /** Target ref for Range mode (commit hash or 'HEAD'). */
  targetRef: string | null
  /** Branch ref for Branch mode. */
  branchRef: string | null
  /** True while the server computes snapshots / diff. */
  isComputing: boolean
  /** Latest progress message from the server SSE stream. */
  computeProgress: string | null
  /** Set when the last diff computation came from the temporal mapper. */
  temporalRange: TemporalRange | null
  /** Latched true after the first successful Branch diff (unlocks the tab). */
  branchTabUsed: boolean
  /** Error from the last computation attempt. */
  diffError: string | null
}

// ── Initialise ────────────────────────────────────────────────────────────────

/**
 * Initialise temporal state fields in the shared store. Called from `core.ts`
 * initial state — these values get merged into `AppState`.
 */
export const temporalInitial: TemporalState = {
  gitBarOpen: false,
  isGitRepo: null,
  currentBranch: null,
  branches: [],
  commits: [],
  selectedBranch: null,
  activeTab: 'range',
  baseRef: null,
  targetRef: null,
  branchRef: null,
  isComputing: false,
  computeProgress: null,
  temporalRange: null,
  branchTabUsed: false,
  diffError: null
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Toggle the git history bar open/closed. Loads git status on first open. */
export async function toggleGitBar(): Promise<void> {
  // If not yet opened, fetch git status first.
  setState('gitBarOpen', (v: boolean) => !v)
  // Check git status if not yet known.
  await refreshGitStatus()
}

/** Fetch git status and branch list for the current project. */
export async function refreshGitStatus(): Promise<void> {
  let status: GitStatus
  try {
    status = await fetchGitStatus()
  } catch {
    return
  }

  setState('isGitRepo', status.isGitRepo)
  setState('currentBranch', status.currentBranch)

  if (!status.isGitRepo) return

  try {
    const { branches } = await fetchBranches()
    setState('branches', branches)
  } catch {
    // Non-fatal — continue with empty branch list.
  }
}

/** Load commits for the given branch (or HEAD if null). */
export async function loadCommits(branch: string | null): Promise<void> {
  setState('selectedBranch', branch)
  setState('commits', [])
  try {
    const commits = await fetchCommits(branch ?? undefined, 50)
    setState('commits', commits)
    // Auto-select the two most recent commits as base/target defaults.
    if (commits.length >= 2) {
      setState('targetRef', commits[0]!.hash)
      setState('baseRef', commits[1]!.hash)
    } else if (commits.length === 1) {
      setState('targetRef', commits[0]!.hash)
      setState('baseRef', null)
    }
  } catch {
    // Non-fatal — commits list stays empty.
  }
}

/** Switch the active tab. */
export function setActiveTab(tab: 'range' | 'branch'): void {
  setState('activeTab', tab)
}

/** Set the base ref (commit hash) for Range mode. */
export function setBaseRef(ref: string | null): void {
  setState('baseRef', ref)
}

/** Set the target ref (commit hash) for Range mode. */
export function setTargetRef(ref: string | null): void {
  setState('targetRef', ref)
}

/** Set the branch ref for Branch mode. */
export function setBranchRef(ref: string | null): void {
  setState('branchRef', ref)
}

/**
 * Run the temporal diff. Sends base and target refs to the server, streams
 * progress via SSE, and stores the resulting diff in the shared store.
 *
 * The live `currentDiff` field (used by DiffPanel) gets populated on success.
 * `temporalRange` records labels for the DiffPanel header.
 */
export async function runTemporalDiff(_projectRoot: string | null): Promise<void> {
  // Determine refs based on active tab.
  // Import state here to avoid circular dep at module load time.
  const { state } = await import('./core.js')

  let base: string | null
  let target: string | null
  let baseLabel: string
  let targetLabel: string

  if (state.activeTab === 'range') {
    base = state.baseRef
    target = state.targetRef
    const findLabel = (hash: string | null) =>
      hash ? (state.commits.find((c: CommitInfo) => c.hash === hash)?.shortHash ?? hash.slice(0, 8)) : null
    baseLabel = findLabel(base) ?? '?'
    targetLabel = findLabel(target) ?? '?'
  } else {
    // Branch mode: diff branch tip → HEAD
    base = state.branchRef
    target = 'HEAD'
    baseLabel = state.branchRef ?? '?'
    targetLabel = 'HEAD'
  }

  if (!base || !target) {
    setState('diffError', 'Select both base and target commits first.')
    return
  }

  setState('isComputing', true)
  setState('computeProgress', 'Starting…')
  setState('diffError', null)
  // Clear previous snapshot-based diff so the new temporal diff takes over.
  setState('baseSnapshot', null)
  setState('currentDiff', null)

  try {
    const diff = await computeDiff(base, target, (msg) => setState('computeProgress', msg))

    setState('currentDiff', diff)
    setState('temporalRange', { baseLabel, targetLabel })

    if (state.activeTab === 'branch') {
      setState('branchTabUsed', true)
    }
  } catch (err) {
    setState('diffError', err instanceof Error ? err.message : 'Computation failed')
  } finally {
    setState('isComputing', false)
    setState('computeProgress', null)
  }
}

/**
 * Re-export `computeArchDiff` under a local alias for use in range step mode.
 * Not referenced currently but available for keyboard ← → navigation.
 */
export { computeArchDiff }
