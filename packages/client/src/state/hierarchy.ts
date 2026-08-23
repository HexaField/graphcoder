import { state, setState } from './core.js'
import { saveHierarchy } from './storage.js'

function persist(): void {
  saveHierarchy({ hiddenPaths: state.hiddenPaths, expandedGroups: state.expandedGroups })
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
  /**
   * File paths (or dir/package path prefixes) whose graph group containers
   * show children expanded in the layout. Empty array = all groups collapsed.
   *
   * A prefix entry expands all files under it — same semantics as hiddenPaths.
   * Only active when any groupBy option is on; ignored otherwise.
   */
  expandedGroups: string[]
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

// ── Group collapse ─────────────────────────────────────────────────────────────

/**
 * Toggle whether a graph group container shows its child nodes in the layout.
 * Key semantics mirror hiddenPaths: file path, dir path, or package path.
 * Prefix matching applies — toggling a dir path expands/collapses all files
 * under that directory.
 */
export function toggleGroupExpanded(key: string): void {
  setState('expandedGroups', (prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  persist()
}

/** Collapse all group containers (clear the expanded set). */
export function collapseAllGroups(): void {
  setState('expandedGroups', [])
  persist()
}

/** Expand all group containers by adding all known file paths. */
export function expandAllGroups(filePaths: string[]): void {
  setState('expandedGroups', filePaths)
  persist()
}
