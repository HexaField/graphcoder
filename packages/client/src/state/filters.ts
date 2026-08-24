import type { EdgeKind, GraphDirection } from '@graphcoder/core'
import { globToRegex } from '@graphcoder/core'
import type { NodeKind } from '@graphcoder/core'
import { state, setState } from './core.js'
import { saveFilters } from './storage.js'
import type { PersistedFilters } from './storage.js'

// Re-export globToRegex so callers that imported it from this module still work.
export { globToRegex }

// ── Filters & focus ───────────────────────────────────────────────────────────

export interface FiltersState {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  /** Comma-separated glob patterns excluded from the visible graph (e.g. `*.test.*, *.config.ts`). */
  excludePatterns: string
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  focusedNodeId: string | null
  /** ELK layout flow direction. LR = left-to-right, TB = top-to-bottom. */
  graphDirection: GraphDirection
}

function persist(): void {
  const f: PersistedFilters = {
    hiddenNodeKinds: state.hiddenNodeKinds,
    hiddenEdgeKinds: state.hiddenEdgeKinds,
    excludePatterns: state.excludePatterns,
    groupByFile: state.groupByFile,
    groupByContract: state.groupByContract,
    groupByClass: state.groupByClass,
    groupByPackage: state.groupByPackage,
    graphDirection: state.graphDirection
  }
  saveFilters(f, state.projectRoot)
}

export function toggleNodeKind(kind: NodeKind): void {
  setState('hiddenNodeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persist()
}

export function toggleEdgeKind(kind: EdgeKind): void {
  setState('hiddenEdgeKinds', (prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  persist()
}

export function setFocus(nodeId: string): void {
  setState('focusedNodeId', nodeId)
}

export function clearFocus(): void {
  setState('focusedNodeId', null)
}

export function setExcludePatterns(value: string): void {
  setState('excludePatterns', value)
  persist()
}

export function toggleGroupByFile(): void {
  setState('groupByFile', (v) => !v)
  persist()
}

export function toggleGroupByContract(): void {
  setState('groupByContract', (v) => !v)
  persist()
}

export function toggleGroupByClass(): void {
  setState('groupByClass', (v) => !v)
  persist()
}

export function toggleGroupByPackage(): void {
  setState('groupByPackage', (v) => !v)
  persist()
}

export function setGraphDirection(dir: GraphDirection): void {
  setState('graphDirection', dir)
  persist()
}

export function clearFilters(): void {
  setState('hiddenNodeKinds', [])
  setState('hiddenEdgeKinds', [])
  setState('excludePatterns', '')
  setState('groupByFile', false)
  setState('groupByContract', false)
  setState('groupByClass', false)
  setState('groupByPackage', false)
  persist()
}
