/**
 * PR Stack state — manages a stacked PR chain for layered code review.
 *
 * When active, the PR stack:
 *   - scopes the graph to only files touched by the stack (scopeFiles)
 *   - auto-imports PR annotations so the sidebar populates immediately
 *   - clicking a PR triggers a temporal diff for that PR's commit range
 *   - ← → keyboard navigation steps through PRs, each triggering a diff
 */
import { setState, state } from './core.js'
import { fetchPrStack, importPrStack } from '../api/git.js'
import type { PrInfo } from '../api/git.js'
import { loadAnnotations } from './annotations.js'
import { syncUrlParams } from './url.js'

export type { PrInfo } from '../api/git.js'

export interface PrStackState {
  prs: PrInfo[]
  activePrIndex: number
  baseRef: string
  tipRef: string
  loading: boolean
  error: string | null
}

export const prStackInitial: PrStackState = {
  prs: [],
  activePrIndex: -1,
  baseRef: '',
  tipRef: '',
  loading: false,
  error: null
}

export async function loadPrStack(base: string, tip: string): Promise<void> {
  setState('prStack', { loading: true, error: null, baseRef: base, tipRef: tip })
  try {
    const result = await fetchPrStack(base, tip)
    setState('prStack', { prs: result.prs, loading: false, activePrIndex: 0 })
    syncUrlParams()

    // Auto-import annotations so the sidebar populates without a manual click.
    await importPrAnnotations()

    // Trigger the diff for the first PR.
    if (result.prs.length > 0) {
      await triggerDiffForPr(result.prs[0])
    }
  } catch (err) {
    setState('prStack', {
      loading: false,
      error: err instanceof Error ? err.message : 'Failed to load PR stack'
    })
  }
}

export async function importPrAnnotations(): Promise<void> {
  const { baseRef, tipRef } = state.prStack
  if (!baseRef || !tipRef) return

  setState('prStack', 'loading', true)
  try {
    await importPrStack(baseRef, tipRef)
    // Reload annotations so the new ones appear in the sidebar
    await loadAnnotations()
  } catch (err) {
    setState('prStack', 'error', err instanceof Error ? err.message : 'Import failed')
  } finally {
    setState('prStack', 'loading', false)
  }
}

/** Set the temporal diff refs, scope to this PR's files, and run the diff. */
async function triggerDiffForPr(pr: PrInfo): Promise<void> {
  // Scope the graph to only files this PR touches — each PR review shows
  // just its own files, not the entire stack.
  // Spread to unwrap SolidJS store proxies — passing a proxy directly to
  // setState for a different key can silently produce an empty array.
  const files = [...pr.files]
  setState('scopeFiles', files)
  // Auto-expand all scoped file groups so symbols render immediately.
  // Without this, all groups collapse and ELK receives empty containers.
  setState('expandedGroups', files)
  setState('baseRef', pr.baseCommitHash)
  setState('targetRef', pr.commitHash)
  const { runTemporalDiff } = await import('./temporal.js')
  await runTemporalDiff()
}

export async function setActivePr(index: number): Promise<void> {
  const prs = state.prStack.prs
  if (index < 0 || index >= prs.length) return
  setState('prStack', 'activePrIndex', index)
  // Unwrap the SolidJS store proxy into a plain object so triggerDiffForPr
  // gets real arrays, not reactive proxies that break setState cross-key.
  const pr = prs[index]
  const plain: PrInfo = {
    index: pr.index,
    branch: pr.branch,
    title: pr.title,
    commitHash: pr.commitHash,
    baseCommitHash: pr.baseCommitHash,
    parentBranch: pr.parentBranch,
    files: [...pr.files],
    stats: { additions: pr.stats.additions, deletions: pr.stats.deletions },
    memberIds: [...pr.memberIds]
  }
  await triggerDiffForPr(plain)
}

export async function nextPr(): Promise<void> {
  const { activePrIndex, prs } = state.prStack
  if (activePrIndex < prs.length - 1) await setActivePr(activePrIndex + 1)
}

export async function prevPr(): Promise<void> {
  const { activePrIndex } = state.prStack
  if (activePrIndex > 0) await setActivePr(activePrIndex - 1)
}

export function clearPrStack(): void {
  setState('prStack', prStackInitial)
  // Remove the scope filter and auto-expanded groups so the full graph returns.
  setState('scopeFiles', [])
  setState('expandedGroups', [])
  syncUrlParams()
}
