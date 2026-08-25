import type { GraphNode } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { setState } from './core.js'

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchState {
  searchQuery: string
  searchResults: { node: GraphNode; score: number }[]
  isSearching: boolean
}

/** Abort controller for the current in-flight search request. */
let searchController: AbortController | null = null
/** Debounce timer — 150 ms batches rapid keystrokes into one request. */
let searchTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Run a fuzzy search against the server and update the search results.
 *
 * Debounces keystrokes by 150 ms and aborts the previous in-flight
 * request when a newer one fires, so rapid typing generates at most
 * one server round-trip per pause.
 */
export function search(query: string): void {
  setState('searchQuery', query)
  clearTimeout(searchTimer)

  if (!query.trim()) {
    searchController?.abort()
    searchController = null
    setState('searchResults', [])
    setState('isSearching', false)
    return
  }

  setState('isSearching', true)

  searchTimer = setTimeout(() => {
    // Abort previous in-flight request before starting the new one.
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller

    api
      .searchNodes(query, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setState('searchResults', result.results)
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setState('error', e instanceof Error ? e.message : 'Search failed')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setState('isSearching', false)
      })
  }, 150)
}
