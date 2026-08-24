import type { EdgeKind, GraphDirection, NodeKind } from '@graphcoder/core'

// ── Key helpers ──────────────────────────────────────────────────────────────

const FILTER_BASE = 'graphcoder-filters'
const HIERARCHY_BASE = 'graphcoder-hierarchy'

/**
 * Build a localStorage key scoped to a project path.
 * Falls back to the bare base key when no project path is available.
 */
function storageKey(base: string, projectPath: string | null): string {
  return projectPath ? `${base}:${projectPath}` : base
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface PersistedFilters {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  /** Comma-separated glob patterns to exclude from the graph (e.g. `*.test.*, *.config.ts`). */
  excludePatterns: string
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  /** Layout flow direction. LR = left-to-right, TB = top-to-bottom. */
  graphDirection: GraphDirection
}

/**
 * Load persisted filter state from localStorage. Returns partial on missing/corrupt data.
 *
 * Tries the project-scoped key first; falls back to the global key so existing
 * settings migrate seamlessly on first open under the new keying scheme.
 */
export function loadFilters(projectPath: string | null = null): Partial<PersistedFilters> {
  try {
    let raw = projectPath ? localStorage.getItem(storageKey(FILTER_BASE, projectPath)) : null
    if (!raw) raw = localStorage.getItem(FILTER_BASE)
    if (!raw) return {}
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return {}
    return {
      hiddenNodeKinds: Array.isArray(p.hiddenNodeKinds) ? (p.hiddenNodeKinds as NodeKind[]) : undefined,
      hiddenEdgeKinds: Array.isArray(p.hiddenEdgeKinds) ? (p.hiddenEdgeKinds as EdgeKind[]) : undefined,
      // Support migrating from the old boolean hideTestFiles — convert to a sensible default pattern
      excludePatterns:
        typeof p.excludePatterns === 'string'
          ? p.excludePatterns
          : p.hideTestFiles === true
            ? '*.test.*, *.spec.*'
            : undefined,
      groupByFile: typeof p.groupByFile === 'boolean' ? p.groupByFile : undefined,
      groupByContract: typeof p.groupByContract === 'boolean' ? p.groupByContract : undefined,
      groupByClass: typeof p.groupByClass === 'boolean' ? p.groupByClass : undefined,
      groupByPackage: typeof p.groupByPackage === 'boolean' ? p.groupByPackage : undefined,
      graphDirection:
        p.graphDirection === 'LR' || p.graphDirection === 'TB' ? (p.graphDirection as GraphDirection) : undefined
    }
  } catch {
    return {}
  }
}

/** Persist filter state to localStorage, scoped to the current project. */
export function saveFilters(f: PersistedFilters, projectPath: string | null = null): void {
  try {
    localStorage.setItem(storageKey(FILTER_BASE, projectPath), JSON.stringify(f))
  } catch {
    // localStorage unavailable (quota exceeded, private-browsing restriction, etc.)
  }
}

// ── Hierarchy ─────────────────────────────────────────────────────────────────

export interface PersistedHierarchy {
  hiddenPaths: string[]
  /**
   * File paths (or dir/package path prefixes) whose graph group containers
   * show expanded children. Empty = all groups collapsed by default.
   * Semantics mirror hiddenPaths: a prefix entry expands all files under it.
   */
  expandedGroups: string[]
}

/**
 * Load persisted hierarchy visibility state from localStorage.
 *
 * Tries the project-scoped key first; falls back to the global key for migration.
 */
export function loadHierarchy(projectPath: string | null = null): Partial<PersistedHierarchy> {
  try {
    let raw = projectPath ? localStorage.getItem(storageKey(HIERARCHY_BASE, projectPath)) : null
    if (!raw) raw = localStorage.getItem(HIERARCHY_BASE)
    if (!raw) return {}
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return {}
    return {
      hiddenPaths: Array.isArray(p.hiddenPaths) ? (p.hiddenPaths as string[]) : undefined,
      expandedGroups: Array.isArray(p.expandedGroups) ? (p.expandedGroups as string[]) : undefined
    }
  } catch {
    return {}
  }
}

/** Persist hierarchy visibility state to localStorage, scoped to the current project. */
export function saveHierarchy(h: PersistedHierarchy, projectPath: string | null = null): void {
  try {
    localStorage.setItem(storageKey(HIERARCHY_BASE, projectPath), JSON.stringify(h))
  } catch {
    // localStorage unavailable
  }
}
