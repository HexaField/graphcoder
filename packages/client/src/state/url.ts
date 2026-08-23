import { state } from './core.js'

/**
 * Push the current projectRoot into the browser URL as a query param,
 * without triggering a navigation.
 */
export function syncUrlParams(): void {
  const params = new URLSearchParams()
  if (state.projectRoot) params.set('project', state.projectRoot)
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}
