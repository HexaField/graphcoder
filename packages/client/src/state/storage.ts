import type { EdgeKind, GraphDirection, NodeKind } from '@graphcoder/core'

// ── Filters ───────────────────────────────────────────────────────────────────

const FILTER_KEY = 'graphcoder-filters'

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

/** Load persisted filter state from localStorage. Returns partial on missing/corrupt data. */
export function loadFilters(): Partial<PersistedFilters> {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
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

/** Persist filter state to localStorage. Silently swallows quota/permission errors. */
export function saveFilters(f: PersistedFilters): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f))
  } catch {
    // localStorage unavailable (quota exceeded, private-browsing restriction, etc.)
  }
}

// ── Hierarchy ─────────────────────────────────────────────────────────────────

const HIERARCHY_KEY = 'graphcoder-hierarchy'

export interface PersistedHierarchy {
  hiddenPaths: string[]
  /**
   * File paths (or dir/package path prefixes) whose graph group containers
   * show expanded children. Empty = all groups collapsed by default.
   * Semantics mirror hiddenPaths: a prefix entry expands all files under it.
   */
  expandedGroups: string[]
}

/** Load persisted hierarchy visibility state from localStorage. */
export function loadHierarchy(): Partial<PersistedHierarchy> {
  try {
    const raw = localStorage.getItem(HIERARCHY_KEY)
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

/** Persist hierarchy visibility state to localStorage. */
export function saveHierarchy(h: PersistedHierarchy): void {
  try {
    localStorage.setItem(HIERARCHY_KEY, JSON.stringify(h))
  } catch {
    // localStorage unavailable
  }
}
