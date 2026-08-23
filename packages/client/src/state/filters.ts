import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from '@graphcoder/core'
import { state, setState } from './core.js'
import { saveFilters } from './storage.js'
import type { PersistedFilters } from './storage.js'

// ── Filters & focus ───────────────────────────────────────────────────────────

export interface FiltersState {
  hiddenNodeKinds: NodeKind[]
  hiddenEdgeKinds: EdgeKind[]
  hideTestFiles: boolean
  hideDevFiles: boolean
  groupByFile: boolean
  groupByContract: boolean
  groupByClass: boolean
  groupByPackage: boolean
  focusedNodeId: string | null
}

function persist(): void {
  const f: PersistedFilters = {
    hiddenNodeKinds: state.hiddenNodeKinds,
    hiddenEdgeKinds: state.hiddenEdgeKinds,
    hideTestFiles: state.hideTestFiles,
    hideDevFiles: state.hideDevFiles,
    groupByFile: state.groupByFile,
    groupByContract: state.groupByContract,
    groupByClass: state.groupByClass,
    groupByPackage: state.groupByPackage
  }
  saveFilters(f)
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

export function toggleHideTestFiles(): void {
  setState('hideTestFiles', (v) => !v)
  persist()
}

export function toggleHideDevFiles(): void {
  setState('hideDevFiles', (v) => !v)
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

export function clearFilters(): void {
  setState('hiddenNodeKinds', [])
  setState('hiddenEdgeKinds', [])
  setState('hideTestFiles', false)
  setState('hideDevFiles', false)
  setState('groupByFile', false)
  setState('groupByContract', false)
  setState('groupByClass', false)
  setState('groupByPackage', false)
  persist()
}

// ── visibleGraph ──────────────────────────────────────────────────────────────

/**
 * Derive the currently visible nodes and edges by applying:
 *   1. Node kind filter  (hiddenNodeKinds)
 *   2. Test / dev file filter  (hideTestFiles, hideDevFiles)
 *   3. Grouping mode coercion  (groupByFile / groupByContract / groupByPackage → drop file nodes;
 *      groupByClass → drop class nodes)
 *   4. Import-node elevation  (import nodes → synthetic `imports` edges)
 *   5. Focus neighbourhood  (focusedNodeId)
 *   6. Edge kind filter  (hiddenEdgeKinds) + endpoint visibility + deduplication
 *
 * Call inside a reactive context (createMemo / createEffect) so SolidJS tracks
 * every state path this reads.
 */
export function visibleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hiddenKindSet = new Set(state.hiddenNodeKinds)
  const hiddenEdgeSet = new Set(state.hiddenEdgeKinds)

  // 1. Apply node kind filter
  let nodes = state.nodes.filter((n) => !hiddenKindSet.has(n.kind))
  let nodeIds = new Set(nodes.map((n) => n.id))

  // 2a. Apply test-file filter — matches .test.* / .spec.* / __tests__ / __mocks__ / .stories.*
  if (state.hideTestFiles) {
    const TEST_RE = /(\.(test|spec)\.[jt]sx?$|__tests__[\\/]|__mocks__[\\/]|\.stories\.[jt]sx?$)/i
    nodes = nodes.filter((n) => !TEST_RE.test(n.filePath ?? ''))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 2b. Apply dev-file filter — package manifests, lock files, config files,
  //     toolchain configs, CI/CD directories, env files, and docs.
  //     Combined with the test filter, what remains is pure application source.
  if (state.hideDevFiles) {
    // Directory segments that are never source: node_modules, .git, .github, etc.
    const DEV_DIR_RE =
      /[\\/](node_modules|\.git|\.github|\.circleci|\.gitlab|dist|build|coverage|\.next|\.nuxt|\.output|\.cache)[\\/]/i
    // Individual files by name/extension at any depth
    const DEV_FILE_RE =
      /([\\/]|^)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb|[^/\\]+\.config\.[cm]?[jt]sx?|tsconfig[^/\\]*\.json|jsconfig[^/\\]*\.json|\.eslintrc[^/\\]*|\.prettierrc[^/\\]*|\.stylelintrc[^/\\]*|\.babelrc[^/\\]*|\.editorconfig|\.browserslistrc|Dockerfile[^/\\]*|docker-compose[^/\\]*|\.dockerignore|\.env(\.[^/\\]*)?|Makefile|Jenkinsfile|\.nvmrc|\.node-version|\.tool-versions|\.gitignore|\.gitattributes|\.npmignore|\.npmrc|README[^/\\]*|LICENSE[^/\\]*|CHANGELOG[^/\\]*|CONTRIBUTING[^/\\]*)$/i
    nodes = nodes.filter((n) => {
      const fp = n.filePath ?? ''
      return !DEV_DIR_RE.test(fp) && !DEV_FILE_RE.test(fp)
    })
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 3a. When grouping by file, contract, or package, remove file-kind nodes —
  //     they become spatial containers drawn in the canvas layer, not graph nodes.
  if (state.groupByFile || state.groupByContract || state.groupByPackage) {
    nodes = nodes.filter((n) => n.kind !== 'file')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 3b. When grouping by class, remove class-kind nodes — they become spatial
  //     containers holding their method/property children. Applies whether or
  //     not file grouping is also on; when both are active, class containers
  //     appear as sub-compounds nested inside file containers.
  if (state.groupByClass) {
    nodes = nodes.filter((n) => n.kind !== 'class')
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 4. Elevate import nodes to direct edges — strip all import-kind nodes from
  //    the visible graph and replace each with synthetic `imports` edges that
  //    connect the containing file/module directly to the import target.
  //    "file → contains → import:X → imports → target" becomes
  //    "file → imports → target", making module dependencies first-class links.
  const syntheticImportEdges: GraphEdge[] = []
  {
    const importIds = new Set<string>()
    for (const n of nodes) {
      if (n.kind === 'import') importIds.add(n.id)
    }

    if (importIds.size > 0) {
      const importContainers = new Map<string, Set<string>>() // importId → container ids
      const importTargets = new Map<string, Set<string>>() // importId → target ids

      for (const e of state.edges) {
        if (e.kind === 'contains' && importIds.has(e.target)) {
          if (!importContainers.has(e.target)) importContainers.set(e.target, new Set())
          importContainers.get(e.target)!.add(e.source)
        }
        if (e.kind === 'imports' && importIds.has(e.source)) {
          if (!importTargets.has(e.source)) importTargets.set(e.source, new Set())
          importTargets.get(e.source)!.add(e.target)
        }
      }

      for (const [importId, containerIds] of importContainers) {
        const targetIds = importTargets.get(importId)
        if (!targetIds) continue
        for (const cid of containerIds) {
          for (const tid of targetIds) {
            if (nodeIds.has(cid) && nodeIds.has(tid) && cid !== tid) {
              syntheticImportEdges.push({ source: cid, target: tid, kind: 'imports' })
            }
          }
        }
      }

      nodes = nodes.filter((n) => !importIds.has(n.id))
      nodeIds = new Set(nodes.map((n) => n.id))
    }
  }

  // 5. Apply focus: narrow to focused node + its direct neighbours
  const focusId = state.focusedNodeId
  if (focusId && nodeIds.has(focusId)) {
    const keep = new Set<string>([focusId])
    for (const e of state.edges) {
      if (e.source === focusId && nodeIds.has(e.target)) keep.add(e.target)
      if (e.target === focusId && nodeIds.has(e.source)) keep.add(e.source)
    }
    nodes = nodes.filter((n) => keep.has(n.id))
    nodeIds = new Set(nodes.map((n) => n.id))
  }

  // 6. Filter edges: kind not hidden, both endpoints visible, deduplicated by
  //    (src, tgt, kind). Import nodes were removed in step 4, so any edge that
  //    referenced one fails the nodeIds check and gets dropped naturally.
  //    Synthetic import-elevation edges are merged in after.
  const seenEdgeKeys = new Set<string>()
  const edges: GraphEdge[] = []

  for (const e of state.edges) {
    if (hiddenEdgeSet.has(e.kind)) continue
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source}|${e.target}|${e.kind}`
    if (seenEdgeKeys.has(key)) continue
    seenEdgeKeys.add(key)
    edges.push(e)
  }

  for (const e of syntheticImportEdges) {
    const key = `${e.source}|${e.target}|${e.kind}`
    if (!seenEdgeKeys.has(key)) {
      seenEdgeKeys.add(key)
      edges.push(e)
    }
  }

  return { nodes, edges }
}
