import { state } from './core.js'

/**
 * Push the current projectRoot and diff range into the browser URL as
 * query params, without triggering a navigation.
 *
 * Tracked params:
 *   - `project`  — absolute path of the open project
 *   - `base`     — base commit hash for a temporal diff
 *   - `target`   — target commit hash for a temporal diff
 */
export function syncUrlParams(): void {
  const params = new URLSearchParams()
  if (state.projectRoot) params.set('project', state.projectRoot)
  if (state.baseRef) params.set('base', state.baseRef)
  if (state.targetRef) params.set('target', state.targetRef)
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}
