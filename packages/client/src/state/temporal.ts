/**
 * Temporal state — Git graph DAG and commit-pair diff.
 *
 * The git graph panel shows all branches and commits as a visual DAG.
 * Users click two commits (or branch tips) to select base and target,
 * then compare to compute an ArchDiff between them.
 */
import { buildDiffIdMap, computeArchDiff, computeView, nodeSemanticId } from '@graphcoder/core'
import type { FileGroup, GraphEdge, GraphNode, GraphSnapshot, ViewParams } from '@graphcoder/core'
import type { NodeSnapshot } from '@graphcoder/core'
import type { BranchRef, GitGraph, GitStatus, GraphCommit } from '../api/git.js'
import { computeDiff, fetchGitGraph, fetchGitStatus } from '../api/git.js'
import { state, setState } from './core.js'
import { syncUrlParams } from './url.js'

// ── State shape ───────────────────────────────────────────────────────────────

export interface TemporalRange {
  baseLabel: string
  targetLabel: string
}

export interface TemporalState {
  /** Whether the git graph panel is visible. */
  gitBarOpen: boolean
  /** Populated after the first status check; null means unknown. */
  isGitRepo: boolean | null
  currentBranch: string | null
  /** Full DAG data from /api/git/graph. */
  gitGraph: GitGraph | null
  /** Branch names the user has expanded to show commits. */
  expandedBranches: string[]
  /** Selected base commit hash (first click). */
  baseRef: string | null
  /** Selected target commit hash (second click). */
  targetRef: string | null
  /** True while the server computes snapshots / diff. */
  isComputing: boolean
  /** Latest progress message from the server SSE stream. */
  computeProgress: string | null
  /** Set when the last diff computation came from the temporal mapper. */
  temporalRange: TemporalRange | null
  /** Error from the last computation attempt. */
  diffError: string | null
  /** Diff status per semantic ID — drives canvas overlay when a temporal diff is active. */
  diffStatusMap: Map<string, 'added' | 'removed' | 'modified' | 'moved'> | null
  /** Diff status per edge key ("srcSem|tgtSem|kind") — drives edge colouring. */
  edgeStatusMap: Map<string, 'added' | 'removed'> | null
  /** Aggregate diff status per filePath — drives hierarchy panel colouring. */
  fileDiffStatus: Map<string, 'added' | 'removed' | 'modified' | 'mixed'> | null
  /** Snapshot of the live view before the diff replaced it — restored on clear. */
  savedView: { nodes: GraphNode[]; edges: GraphEdge[]; groups: FileGroup[]; fileNodes: GraphNode[] } | null
  /** Raw unfiltered diff nodes/edges — re-filtered via computeView when filters change during a diff. */
  rawDiffView: { nodes: GraphNode[]; edges: GraphEdge[]; fileNodes: GraphNode[] } | null
  /**
   * Reverse map: semantic ID → CodeGraph ID from the target snapshot.
   * Populated during buildDiffView. Lets selectNode resolve the original
   * CodeGraph ID for REST calls when a diff view occupies the display.
   * Falls back to the base snapshot for removed nodes.
   */
  diffCgIdMap: Map<string, string> | null
}

// ── Initialise ────────────────────────────────────────────────────────────────

export const temporalInitial: TemporalState = {
  gitBarOpen: false,
  isGitRepo: null,
  currentBranch: null,
  gitGraph: null,
  expandedBranches: [],
  baseRef: null,
  targetRef: null,
  isComputing: false,
  computeProgress: null,
  temporalRange: null,
  diffError: null,
  diffStatusMap: null,
  edgeStatusMap: null,
  fileDiffStatus: null,
  savedView: null,
  rawDiffView: null,
  diffCgIdMap: null
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Toggle the git graph panel open/closed. Loads graph data on first open. */
export async function toggleGitBar(): Promise<void> {
  const { state } = await import('./core.js')
  const wasOpen = state.gitBarOpen

  setState('gitBarOpen', (v: boolean) => !v)
  await refreshGitStatus()

  // Load graph data when opening for the first time.
  if (!wasOpen && state.isGitRepo && !state.gitGraph) {
    await loadGitGraph()
  }
}

/** Fetch git status for the current project. */
export async function refreshGitStatus(): Promise<void> {
  let status: GitStatus
  try {
    status = await fetchGitStatus()
  } catch {
    return
  }

  setState('isGitRepo', status.isGitRepo)
  setState('currentBranch', status.currentBranch)
}

/** Load the full git DAG from the server. */
export async function loadGitGraph(): Promise<void> {
  try {
    const graph = await fetchGitGraph(200)
    setState('gitGraph', graph)
  } catch {
    // Non-fatal — graph stays null.
  }
}

/** Toggle a branch's expanded state (show/hide its commits). */
export function toggleBranchExpanded(branchName: string): void {
  setState('expandedBranches', (prev: string[]) =>
    prev.includes(branchName) ? prev.filter((b) => b !== branchName) : [...prev, branchName]
  )
}

/**
 * Handle a commit click. First click sets base, second click sets target.
 * Clicking a selected commit deselects it.
 */
export async function selectCommit(hash: string): Promise<void> {
  const { state } = await import('./core.js')

  if (state.baseRef === hash) {
    setState('baseRef', null)
    syncUrlParams()
    return
  }
  if (state.targetRef === hash) {
    setState('targetRef', null)
    syncUrlParams()
    return
  }

  if (!state.baseRef) {
    setState('baseRef', hash)
  } else if (!state.targetRef) {
    setState('targetRef', hash)
  } else {
    // Both set — replace target.
    setState('targetRef', hash)
  }
  syncUrlParams()
}

/** Swap base and target. */
export function swapRefs(): void {
  // Read current values before mutating.
  // Dynamic import avoids circular dep.
  void import('./core.js').then(({ state }) => {
    const b = state.baseRef
    const t = state.targetRef
    setState('baseRef', t)
    setState('targetRef', b)
    syncUrlParams()
  })
}

/** Clear base and target selection. */
export function clearSelection(): void {
  setState('baseRef', null)
  setState('targetRef', null)
  syncUrlParams()
}

// ── Diff view helpers ────────────────────────────────────────────────────────

/** Convert a NodeSnapshot (from ArchOp) to a GraphNode for the canvas. */
function snapshotToGraphNode(snap: NodeSnapshot): GraphNode {
  return {
    id: snap.id,
    kind: snap.kind,
    name: snap.name,
    qualifiedName: snap.qualifiedName,
    filePath: snap.filePath,
    language: snap.language,
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    signature: snap.signature,
    visibility: snap.visibility,
    isExported: snap.isExported,
    isAsync: snap.isAsync,
    isStatic: snap.isStatic,
    isAbstract: snap.isAbstract,
    decorators: snap.decorators,
    typeParameters: snap.typeParameters,
    returnType: snap.returnType,
    updatedAt: 0
  }
}

/** Build file-level groups from a flat node list (simple grouping by filePath). */
function buildDiffFileGroups(nodes: GraphNode[]): FileGroup[] {
  const byFile = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const list = byFile.get(n.filePath) ?? []
    list.push(n)
    byFile.set(n.filePath, list)
  }
  return [...byFile.entries()].map(([path, children]) => ({
    id: `diff-file:${path}`,
    label: path,
    childIds: children.map((c) => c.id),
    filePath: path
  }))
}

/**
 * Build the merged diff view: target snapshot + removed nodes from the diff.
 *
 * Returns the merged node/edge lists, file groups, and status maps for the
 * canvas overlay.
 */
function buildDiffView(
  baseSnapshot: GraphSnapshot,
  targetSnapshot: GraphSnapshot,
  diff: import('@graphcoder/core').ArchDiff
): {
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: FileGroup[]
  fileNodes: GraphNode[]
  nodeStatus: Map<string, 'added' | 'removed' | 'modified' | 'moved'>
  edgeStatus: Map<string, 'added' | 'removed'>
  fileDiffStatus: Map<string, 'added' | 'removed' | 'modified' | 'mixed'>
  cgIdMap: Map<string, string>
} {
  // Start with all target nodes (the "after" state).
  const mergedNodes = [...targetSnapshot.nodes]
  const mergedNodeIds = new Set(mergedNodes.map((n) => n.id))

  // Build node + edge status maps from diff operations.
  const nodeStatus = new Map<string, 'added' | 'removed' | 'modified' | 'moved'>()
  const edgeStatus = new Map<string, 'added' | 'removed'>()

  // We need CodeGraph-ID → semantic-ID maps for both snapshots to resolve edges.
  const baseCgToSem = new Map<string, string>()
  const targetCgToSem = new Map<string, string>()
  for (const n of baseSnapshot.nodes) baseCgToSem.set(n.id, nodeSemanticId(n))
  for (const n of targetSnapshot.nodes) targetCgToSem.set(n.id, nodeSemanticId(n))

  // Semantic-ID → filePath lookup for modify/move operations.
  const semToFilePath = new Map<string, string>()
  for (const n of targetSnapshot.nodes) semToFilePath.set(nodeSemanticId(n), n.filePath)
  for (const n of baseSnapshot.nodes) {
    const sem = nodeSemanticId(n)
    if (!semToFilePath.has(sem)) semToFilePath.set(sem, n.filePath)
  }

  // Accumulate per-file diff statuses for the hierarchy panel.
  const filePathStatuses = new Map<string, Set<string>>()
  function trackFileStatus(filePath: string, status: string): void {
    if (!filePath) return
    const set = filePathStatuses.get(filePath) ?? new Set()
    // Normalise 'moved' to 'modified' for file-level aggregation.
    set.add(status === 'moved' ? 'modified' : status)
    filePathStatuses.set(filePath, set)
  }

  for (const op of diff.operations) {
    switch (op.op) {
      case 'add_node':
        nodeStatus.set(op.node.id, 'added')
        trackFileStatus(op.node.filePath, 'added')
        break
      case 'remove_node': {
        nodeStatus.set(op.id, 'removed')
        trackFileStatus(op.node.filePath, 'removed')
        // Inject removed node into the merged view so it appears on the canvas.
        if (!mergedNodeIds.has(op.id)) {
          mergedNodes.push(snapshotToGraphNode(op.node))
          mergedNodeIds.add(op.id)
        }
        break
      }
      case 'modify_node':
        nodeStatus.set(op.id, 'modified')
        trackFileStatus(semToFilePath.get(op.id) ?? '', 'modified')
        break
      case 'move_node':
        nodeStatus.set(op.id, 'moved')
        trackFileStatus(op.to.filePath, 'modified')
        break
      case 'add_edge':
        edgeStatus.set(`${op.edge.source}|${op.edge.target}|${op.edge.kind}`, 'added')
        break
      case 'remove_edge':
        edgeStatus.set(`${op.edge.source}|${op.edge.target}|${op.edge.kind}`, 'removed')
        break
    }
  }

  // Merge edges: target edges + removed edges whose endpoints both exist.
  // Target edges use CodeGraph IDs — remap to semantic IDs for the status map.
  const mergedEdges: GraphEdge[] = targetSnapshot.edges.map((e) => ({
    ...e,
    source: targetCgToSem.get(e.source) ?? e.source,
    target: targetCgToSem.get(e.target) ?? e.target
  }))
  const edgeKeySet = new Set(mergedEdges.map((e) => `${e.source}|${e.target}|${e.kind}`))

  // Build a semantic-ID set for edge-endpoint validation.
  // `mergedNodeIds` still holds CodeGraph IDs for target nodes at this
  // point (remapping happens at line 341–344), so it rejects valid
  // semantic-ID endpoints from removed-edge operations.  A parallel set
  // of semantic IDs avoids false-negative endpoint checks.
  const mergedSemIds = new Set<string>()
  for (const sem of targetCgToSem.values()) mergedSemIds.add(sem)
  for (const op of diff.operations) {
    if (op.op === 'remove_node') mergedSemIds.add(op.id)
  }

  // Track removed child nodes — these need their original `contains`
  // edge restored so computeView can place them inside file groups.
  const removedNodeIds = new Set<string>()
  for (const op of diff.operations) {
    if (op.op === 'remove_node') removedNodeIds.add(op.id)
  }

  // Add removed edges that don't already exist in the merged set.
  // `contains` edges are restored only for removed child nodes — adding
  // the old parent→child back for a moved/modified node would give it
  // two parents, crashing ELK with "value already present".
  for (const op of diff.operations) {
    if (op.op !== 'remove_edge') continue
    if (op.edge.kind === 'contains' && !removedNodeIds.has(op.edge.target)) continue
    const key = `${op.edge.source}|${op.edge.target}|${op.edge.kind}`
    if (edgeKeySet.has(key)) continue
    if (mergedSemIds.has(op.edge.source) && mergedSemIds.has(op.edge.target)) {
      mergedEdges.push({ source: op.edge.source, target: op.edge.target, kind: op.edge.kind })
      edgeKeySet.add(key)
    }
  }

  // Remap target node IDs from CodeGraph IDs to semantic IDs so the diff
  // overlay can match them. Keep the semantic ID as the node's `id`.
  // Build a reverse map (semantic → CodeGraph ID) so REST lookups can
  // resolve back to the server's native IDs.
  const cgIdMap = buildDiffIdMap(baseSnapshot.nodes, targetSnapshot.nodes)
  for (const n of mergedNodes) {
    const sem = targetCgToSem.get(n.id) ?? baseCgToSem.get(n.id)
    if (sem && sem !== n.id) n.id = sem
  }

  // Deduplicate after ID remapping — identically-named symbols in
  // different files can still collide on semantic ID. Keep the first
  // occurrence (target snapshot version, which represents the current state).
  {
    const seen = new Set<string>()
    const deduped: GraphNode[] = []
    for (const n of mergedNodes) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      deduped.push(n)
    }
    mergedNodes.length = 0
    mergedNodes.push(...deduped)
    // Rebuild the set so downstream edge endpoint checks stay correct.
    mergedNodeIds.clear()
    for (const n of mergedNodes) mergedNodeIds.add(n.id)
  }

  // Synthesise missing `contains` edges for nodes that lack a containment
  // parent (e.g. `route` nodes that CodeGraph extracts without creating a
  // file → route containment edge). Without this, orphan nodes float
  // outside all file groups in computeView's layout.
  {
    const hasContainsParent = new Set<string>()
    for (const e of mergedEdges) {
      if (e.kind === 'contains') hasContainsParent.add(e.target)
    }
    const fileIdByPath = new Map<string, string>()
    for (const n of mergedNodes) {
      if ((n.kind === 'file' || n.kind === 'module') && n.filePath) {
        fileIdByPath.set(n.filePath, n.id)
      }
    }
    for (const n of mergedNodes) {
      if (n.kind === 'file' || n.kind === 'module') continue
      if (hasContainsParent.has(n.id)) continue
      if (!n.filePath) continue
      const fileId = fileIdByPath.get(n.filePath)
      if (!fileId) continue
      const key = `${fileId}|${n.id}|contains`
      if (!edgeKeySet.has(key)) {
        mergedEdges.push({ source: fileId, target: n.id, kind: 'contains' })
        edgeKeySet.add(key)
      }
    }
  }

  const groups = buildDiffFileGroups(mergedNodes)

  // Build synthetic file nodes for the hierarchy panel — one per unique filePath.
  const uniqueFilePaths = new Set<string>()
  for (const n of mergedNodes) if (n.filePath) uniqueFilePaths.add(n.filePath)
  const fileNodes: GraphNode[] = [...uniqueFilePaths].map((fp) => ({
    id: `diff-file:${fp}`,
    kind: 'file' as GraphNode['kind'],
    name: fp.split('/').pop() ?? fp,
    qualifiedName: fp,
    filePath: fp,
    language: '',
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0
  }))

  // Convert accumulated per-file status sets into a single aggregate status.
  const fileDiffStatus = new Map<string, 'added' | 'removed' | 'modified' | 'mixed'>()
  for (const [fp, statuses] of filePathStatuses) {
    if (statuses.size === 1) {
      fileDiffStatus.set(fp, [...statuses][0] as 'added' | 'removed' | 'modified')
    } else {
      fileDiffStatus.set(fp, 'mixed')
    }
  }

  return { nodes: mergedNodes, edges: mergedEdges, groups, fileNodes, nodeStatus, edgeStatus, fileDiffStatus, cgIdMap }
}

/**
 * Run the temporal diff between baseRef and targetRef.
 *
 * Fetches both snapshots from the server, computes (or retrieves cached) the
 * diff, builds a merged diff view, and pushes it into the canvas state.
 */
export async function runTemporalDiff(): Promise<void> {
  const { state } = await import('./core.js')

  const base = state.baseRef
  const target = state.targetRef

  if (!base || !target) {
    setState('diffError', 'Select two commits to compare.')
    return
  }

  // Build labels from the graph data.
  const graph = state.gitGraph
  const labelFor = (hash: string): string => {
    const branch = graph?.branches.find((b: BranchRef) => b.hash === hash)
    if (branch) return branch.name
    const commit = graph?.commits.find((c: GraphCommit) => c.hash === hash)
    return commit?.shortHash ?? hash.slice(0, 8)
  }

  setState('isComputing', true)
  setState('computeProgress', 'Starting…')
  setState('diffError', null)
  setState('baseSnapshot', null)
  setState('currentDiff', null)

  try {
    const result = await computeDiff(base, target, (msg) => setState('computeProgress', msg))

    // Save the live view so we can restore it when the diff clears.
    if (!state.savedView) {
      setState('savedView', {
        nodes: [...state.viewNodes],
        edges: [...state.viewEdges],
        groups: [...state.viewGroups],
        fileNodes: [...state.fileNodes]
      })
    }

    // Build the merged diff view and push it into the canvas + hierarchy.
    const dv = buildDiffView(result.baseSnapshot, result.targetSnapshot, result.diff)

    // Store unfiltered diff data so filter changes can re-apply computeView.
    setState('rawDiffView', { nodes: dv.nodes, edges: dv.edges, fileNodes: dv.fileNodes })

    // Apply current filter/collapse state to the diff view — same pipeline the
    // server uses for the live graph, so hidden kinds, paths, grouping, and
    // collapse all take effect.
    const viewParams: ViewParams = {
      hiddenNodeKinds: state.hiddenNodeKinds,
      hiddenEdgeKinds: state.hiddenEdgeKinds,
      hiddenPaths: state.hiddenPaths,
      excludePatterns: state.excludePatterns,
      groupByFile: state.groupByFile,
      groupByClass: state.groupByClass,
      groupByContract: state.groupByContract,
      groupByPackage: state.groupByPackage,
      expandedGroups: state.expandedGroups,
      focusedNodeId: state.focusedNodeId
    }
    const filtered = computeView(dv.nodes, dv.edges, viewParams)

    setState('viewNodes', filtered.nodes)
    setState('viewEdges', filtered.edges)
    setState('viewGroups', filtered.groups)
    // Keep the diff's synthetic fileNodes — computeView's list misses removed files.
    setState('fileNodes', dv.fileNodes)
    setState('diffStatusMap', dv.nodeStatus)
    setState('edgeStatusMap', dv.edgeStatus)
    setState('fileDiffStatus', dv.fileDiffStatus)
    setState('diffCgIdMap', dv.cgIdMap)
    setState('currentDiff', result.diff)
    setState('temporalRange', { baseLabel: labelFor(base), targetLabel: labelFor(target) })
    syncUrlParams()
  } catch (err) {
    setState('diffError', err instanceof Error ? err.message : 'Computation failed')
  } finally {
    setState('isComputing', false)
    setState('computeProgress', null)
  }
}

/**
 * Re-filter the active diff view with updated ViewParams.
 *
 * Called by the reactive effect in App.tsx when filters or collapse state
 * change while a temporal diff occupies the display. Uses the stored raw
 * diff data and runs it through computeView so hidden kinds, paths,
 * grouping, and collapse all apply.
 */
export function refilterDiffView(params: ViewParams): void {
  const raw = state.rawDiffView
  if (!raw) return
  const filtered = computeView(raw.nodes, raw.edges, params)
  setState('viewNodes', filtered.nodes)
  setState('viewEdges', filtered.edges)
  setState('viewGroups', filtered.groups)
  // fileNodes stay unchanged — synthetic diff fileNodes already in state.
}

export { computeArchDiff }
