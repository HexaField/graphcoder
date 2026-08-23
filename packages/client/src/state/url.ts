import type { ViewMode } from '@graphcoder/core'
import { state } from './core.js'

export const VIEW_MODES: ViewMode[] = ['module-dependency', 'call-graph', 'impact-radius']

/**
 * Push the current projectRoot + viewMode into the browser URL as query
 * params, without triggering a navigation.
 */
export function syncUrlParams(): void {
  const params = new URLSearchParams()
  if (state.projectRoot) params.set('project', state.projectRoot)
  params.set('view', state.viewMode)
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}
