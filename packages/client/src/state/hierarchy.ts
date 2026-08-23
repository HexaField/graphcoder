import { state, setState } from './core.js'
import { saveHierarchy } from './storage.js'

function persist(): void {
  saveHierarchy({ hiddenPaths: state.hiddenPaths })
}

// ── Hierarchy ─────────────────────────────────────────────────────────────────

/**
 * Paths and node IDs explicitly hidden via the HierarchyPanel show/hide toggles.
 *
 * Keys:
 *   - Package: `"packages/client"` (directory path prefix)
 *   - Directory: `"packages/client/src/state"` (directory path prefix)
 *   - File: the file node's `filePath` (e.g. `"packages/client/src/state/store.ts"`)
 *   - Symbol: the graph node's `id`
 *
 * Effective visibility of a node = its own key absent from this set AND no
 * ancestor path prefix present. Parent hide cascades to children; parent un-hide
 * restores children to their own state without overriding it.
 */
export interface HierarchyState {
  hiddenPaths: string[]
}

/** Toggle the explicit hidden state of a hierarchy item by its key. */
export function toggleHierarchyHidden(key: string): void {
  setState('hiddenPaths', (prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  persist()
}

/** Replace the entire hidden set atomically (used for bulk operations). */
export function setHiddenPaths(paths: string[]): void {
  setState('hiddenPaths', paths)
  persist()
}

/** Remove all hierarchy visibility overrides. */
export function clearHierarchyHidden(): void {
  setState('hiddenPaths', [])
  persist()
}
