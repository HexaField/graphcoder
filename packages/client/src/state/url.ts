import { state } from './core.js'

/**
 * Push the current projectRoot, diff range, and PR stack refs into the
 * browser URL as query params, without triggering a navigation.
 *
 * Tracked params:
 *   - `project`  — absolute path of the open project
 *   - `base`     — base commit hash for a temporal diff
 *   - `target`   — target commit hash for a temporal diff
 *   - `prBase`   — base ref for the PR stack
 *   - `prTip`    — tip ref for the PR stack
 */
export function syncUrlParams(): void {
  const params = new URLSearchParams()
  if (state.projectRoot) params.set('project', state.projectRoot)
  if (state.baseRef) params.set('base', state.baseRef)
  if (state.targetRef) params.set('target', state.targetRef)
  if (state.prStack.baseRef) params.set('prBase', state.prStack.baseRef)
  if (state.prStack.tipRef) params.set('prTip', state.prStack.tipRef)
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}
