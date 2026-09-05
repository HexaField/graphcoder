/**
 * PR Stack state — manages a stacked PR chain for layered code review.
 *
 * When active, the PR stack colours nodes by which PR introduced them and
 * lets the user step through the stack with keyboard navigation.
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

export function setActivePr(index: number): void {
  setState('prStack', 'activePrIndex', index)
}

export function nextPr(): void {
  const { activePrIndex, prs } = state.prStack
  if (activePrIndex < prs.length - 1) setActivePr(activePrIndex + 1)
}

export function prevPr(): void {
  const { activePrIndex } = state.prStack
  if (activePrIndex > 0) setActivePr(activePrIndex - 1)
}

export function clearPrStack(): void {
  setState('prStack', prStackInitial)
  syncUrlParams()
}
