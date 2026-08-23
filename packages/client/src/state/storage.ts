import type { EdgeKind, NodeKind } from '@graphcoder/core'

// ── Filters ───────────────────────────────────────────────────────────────────

const FILTER_KEY = 'graphcoder-filters'

export interface PersistedFilters {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  hideTestFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
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
      hideTestFiles: typeof p.hideTestFiles === 'boolean' ? p.hideTestFiles : undefined,
      groupByFile: typeof p.groupByFile === 'boolean' ? p.groupByFile : undefined,
      groupByContract: typeof p.groupByContract === 'boolean' ? p.groupByContract : undefined,
      groupByClass: typeof p.groupByClass === 'boolean' ? p.groupByClass : undefined,
      groupByPackage: typeof p.groupByPackage === 'boolean' ? p.groupByPackage : undefined
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
}

/** Load persisted hierarchy visibility state from localStorage. */
export function loadHierarchy(): Partial<PersistedHierarchy> {
  try {
    const raw = localStorage.getItem(HIERARCHY_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return {}
    return {
      hiddenPaths: Array.isArray(p.hiddenPaths) ? (p.hiddenPaths as string[]) : undefined
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
