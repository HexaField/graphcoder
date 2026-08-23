import type { GraphNode } from '@graphcoder/core'
import * as api from '../api/graph.js'
import { setState } from './core.js'

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchState {
  searchQuery: string
  searchResults: { node: GraphNode; score: number }[]
  isSearching: boolean
}

/** Run a fuzzy search against the server and update the search results. */
export async function search(query: string): Promise<void> {
  setState('searchQuery', query)
  if (!query.trim()) {
    setState('searchResults', [])
    return
  }
  setState('isSearching', true)
  try {
    const result = await api.searchNodes(query)
    setState('searchResults', result.results)
  } catch (e) {
    setState('error', e instanceof Error ? e.message : 'Search failed')
  } finally {
    setState('isSearching', false)
  }
}
