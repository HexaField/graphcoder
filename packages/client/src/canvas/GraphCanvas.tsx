/**
 * GraphCanvas — SolidJS wrapper around ThreeRenderer.
 *
 * Reactive interface:
 *   - ELK layout effect: re-runs when the server sends a new view_snapshot
 *     (viewNodes / viewEdges / viewGroups) or the layout direction changes.
 *   - Camera fit on first layout.
 *   - Scene update effect (selection, diff overlay, theme).
 *   - Pan/zoom via wheel + mouse drag.
 *   - Hover hit testing via RBush (nodes + containers) + CPU edge proximity.
 *   - Click hit testing: select node or toggle group expand/collapse.
 *   - Tooltip overlay and expand/collapse button for non-leaf containers.
 *
 * All filtering and group computation runs server-side (core computeView).
 * This component receives pre-filtered data and forwards it straight to ELK.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  Show,
  Switch,
  Match
} from 'solid-js'
import type { FileGroup, GraphNode, Point } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { layoutGraph, type LayoutResult } from '../layout/elk.js'
import {
  addAnnotation,
  addGroupExpanded,
  clearFocus,
  collapseGroup,
  loadAnnotations,
  selectNode,
  state
} from '../state/store.js'
import {
  interactionMode,
  setInteractionMode,
  pendingAnnotation,
  setPendingAnnotation,
  clearPendingAnnotation,
  pointInPolygon,
  simplifyStroke,
  centroid
} from '../state/interaction.js'
import { KindInput } from '../components/KindInput.js'
import { resolvedTheme } from '../state/theme.js'
import type { DiffOverlay, HitResult } from './ThreeRenderer.js'
import { ThreeRenderer } from './ThreeRenderer.js'
import { AnnotationOverlay } from './AnnotationOverlay.js'

/** Layout result paired with the node lookup used to produce it.
 *  Keeping them together prevents rendering with a mismatched (layout, nodeById)
 *  pair during the async window between a viewNodes update and ELK resolving. */
interface LayoutSnap {
  result: LayoutResult
  nodeById: Map<string, GraphNode>
}

// ── Tooltip data types ────────────────────────────────────────────────────────

type NodeTooltip = { kind: 'node'; id: string; name: string; nodeKind?: string }
type ContainerTooltip = { kind: 'container'; id: string; label: string; collapsed: boolean; filePath?: string }
type EdgeTooltip = { kind: 'edge'; id: string; edgeKind?: string; source: string; target: string }
type TooltipData = NodeTooltip | ContainerTooltip | EdgeTooltip

// ── GraphCanvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Camera state: pan offset (world coords → screen) + zoom
  const [cam, setCam] = createSignal({ panX: 0, panY: 0, zoom: 1 })
  const [rendererReady, setRendererReady] = createSignal(false)
  const [layoutError, setLayoutError] = createSignal<string | null>(null)

  // Hover / tooltip state
  const [tooltipData, setTooltipData] = createSignal<TooltipData | null>(null)
  const [mousePos, setMousePos] = createSignal({ x: 0, y: 0 })
  const [cursor, setCursor] = createSignal<'default' | 'pointer'>('default')

  let canvasRef: HTMLCanvasElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  let r3: ThreeRenderer | null = null

  // needsFit triggers a fit-to-view on the next scene render.
  // hadLayout prevents re-fitting on expand/collapse reruns — only the
  // first layout after nodes go from empty → non-empty triggers a fit.
  let needsFit = false
  let hadLayout = false

  // pendingAnchor: set when the user clicks expand/collapse on a container.
  // The scene update effect reads this after ELK resolves and adjusts the
  // camera so the container's top-left stays at the same screen position —
  // preventing the whole graph from jumping relative to the focused item.
  interface ContainerAnchor {
    /** FileContainer.id (= FileGroup.id = fn.id) to find in the new layout. */
    containerId: string
    /** Screen X of the container's top-left at click time. */
    screenX: number
    /** Screen Y of the container's top-left at click time. */
    screenY: number
  }
  let pendingAnchor: ContainerAnchor | null = null

  // ── Reactive memos ──────────────────────────────────────────────────────────

  const semanticToLayoutId = createMemo(() => {
    const map = new Map<string, string>()
    for (const n of state.viewNodes) {
      map.set(nodeSemanticId(n), n.id)
    }
    return map
  })

  const diffOverlay = createMemo((): DiffOverlay => {
    const emptyCS = new Map<string, 'added' | 'removed' | 'modified' | 'mixed'>()
    const empty: DiffOverlay = {
      added: new Set<string>(),
      removed: new Set<string>(),
      modified: new Set<string>(),
      moved: new Set<string>(),
      edgeAdded: new Set<string>(),
      edgeRemoved: new Set<string>(),
      containerStatus: emptyCS
    }

    // Build node status sets from whichever source provides them.
    let added: Set<string>
    let removed: Set<string>
    let modified: Set<string>
    let moved: Set<string>
    let edgeAdded: Set<string>
    let edgeRemoved: Set<string>

    const statusMap = state.diffStatusMap
    const edgeMap = state.edgeStatusMap
    if (statusMap) {
      added = new Set<string>()
      removed = new Set<string>()
      modified = new Set<string>()
      moved = new Set<string>()
      for (const [id, s] of statusMap) {
        if (s === 'added') added.add(id)
        else if (s === 'removed') removed.add(id)
        else if (s === 'modified') modified.add(id)
        else if (s === 'moved') moved.add(id)
      }
      edgeAdded = new Set<string>()
      edgeRemoved = new Set<string>()
      if (edgeMap) {
        for (const [k, s] of edgeMap) {
          if (s === 'added') edgeAdded.add(k)
          else if (s === 'removed') edgeRemoved.add(k)
        }
      }
    } else {
      // Fallback: snapshot-based diff (non-temporal).
      const diff = state.currentDiff
      if (!diff) return empty
      added = new Set<string>()
      removed = new Set<string>()
      modified = new Set<string>()
      moved = new Set<string>()
      for (const op of diff.operations) {
        if (op.op === 'add_node') added.add(op.node.id)
        else if (op.op === 'remove_node') removed.add(op.id)
        else if (op.op === 'modify_node') modified.add(op.id)
        else if (op.op === 'move_node') moved.add(op.id)
      }
      edgeAdded = new Set<string>()
      edgeRemoved = new Set<string>()
    }

    // Build a lookup of all node-level statuses (by node ID, not just semantic ID).
    const allNodeStatuses = new Set([...added, ...removed, ...modified, ...moved])

    // VS Code-style container propagation: collapsed containers inherit
    // aggregate diff status from their children. Expanded containers show
    // nothing — their children carry their own status.
    const containerStatus = new Map<string, 'added' | 'removed' | 'modified' | 'mixed'>()

    // Build node-ID → semantic-ID map for current viewNodes so we can match
    // container childIds (which use CodeGraph IDs) against the diff status sets.
    const nodeById = new Map<string, GraphNode>()
    for (const n of state.viewNodes) nodeById.set(n.id, n)

    const nodeIdStatus = (id: string): string | null => {
      // Try direct lookup (diff view uses semantic IDs as node IDs).
      if (added.has(id)) return 'added'
      if (removed.has(id)) return 'removed'
      if (modified.has(id)) return 'modified'
      if (moved.has(id)) return 'moved'
      // Try semantic ID lookup.
      const n = nodeById.get(id)
      if (!n) return null
      const sem = nodeSemanticId(n)
      if (added.has(sem)) return 'added'
      if (removed.has(sem)) return 'removed'
      if (modified.has(sem)) return 'modified'
      if (moved.has(sem)) return 'moved'
      return null
    }

    // Walk groups: for collapsed containers, aggregate child statuses.
    const expandedGroups = new Set(state.expandedGroups)
    const walkGroup = (g: FileGroup) => {
      // A group counts as collapsed if NOT in expandedGroups.
      const collapsed = !expandedGroups.has(g.filePath ?? g.id)
      if (!collapsed) return // expanded → children show their own status

      const statuses = new Set<string>()
      for (const cid of g.childIds) {
        const s = nodeIdStatus(cid)
        if (s) statuses.add(s)
      }
      // Also check child groups (class sub-groups).
      for (const sg of g.childGroups ?? []) {
        for (const cid of sg.childIds) {
          const s = nodeIdStatus(cid)
          if (s) statuses.add(s)
        }
      }

      if (statuses.size === 0) return
      if (statuses.size === 1) {
        const only = [...statuses][0] as 'added' | 'removed' | 'modified' | 'moved'
        containerStatus.set(g.id, only === 'moved' ? 'modified' : only)
      } else {
        containerStatus.set(g.id, 'mixed')
      }
    }

    if (allNodeStatuses.size > 0) {
      for (const g of state.viewGroups) walkGroup(g)
    }

    return { added, removed, modified, moved, edgeAdded, edgeRemoved, containerStatus }
  })

  // ── ELK layout effect ───────────────────────────────────────────────────────
  // Fires when the server sends a new view_snapshot or the direction changes.
  // All filtering, group building, collapse logic, and edge promotion ran
  // server-side — this effect just calls ELK with what it receives.
  //
  // Multiple view_snapshots can arrive rapidly (WS connect → openProject
  // broadcast → persisted-params view_request). The version counter discards
  // stale results so the last-STARTED layout always wins — not last-resolved.

  const [layoutSnap, setLayoutSnap] = createSignal<LayoutSnap | null>(null)

  // Safety cap: prevent the ELK worker from OOMing if the server somehow sends
  // a very large view. Normal usage stays well below this threshold because
  // collapsed groups are represented as placeholder nodes (O(files) not
  // O(files × symbols)).
  const MAX_LAYOUT_NODES = 5000

  let layoutVersion = 0

  createEffect(async () => {
    const nodes = state.viewNodes
    const edges = state.viewEdges
    const groups = state.viewGroups.length > 0 ? state.viewGroups : undefined
    const direction = state.graphDirection

    const ver = ++layoutVersion

    if (nodes.length === 0) {
      if (ver === layoutVersion) {
        setLayoutSnap(null)
        setLayoutError(null)
        hadLayout = false
      }
      return
    }

    if (nodes.length > MAX_LAYOUT_NODES) {
      if (ver === layoutVersion) {
        setLayoutError(`Too many nodes to lay out (${nodes.length}, limit ${MAX_LAYOUT_NODES}). Collapse some groups.`)
        setIsLayouting(false)
      }
      return
    }

    if (ver === layoutVersion) {
      setIsLayouting(true)
      setLayoutError(null)
      if (!hadLayout) {
        needsFit = true
        hadLayout = true
      }
    }

    try {
      const result = await layoutGraph(nodes, edges, direction, groups)
      if (ver === layoutVersion) {
        // Pair the result with the exact nodeById that produced it — prevents the
        // scene from rendering a mismatched (layout, nodeById) pair during the
        // async gap between a viewNodes update and ELK resolving.
        setLayoutSnap({ result, nodeById: new Map(nodes.map((n) => [n.id, n])) })
        // Clear stale tooltip data when layout changes.
        setTooltipData(null)
      }
    } catch (err) {
      if (ver === layoutVersion) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[GraphCanvas] Layout failed:', err)
        setLayoutError(msg)
      }
    } finally {
      if (ver === layoutVersion) {
        setIsLayouting(false)
      }
    }
  })

  // ── Scene update effect ─────────────────────────────────────────────────────
  // layoutSnap holds the layout result and nodeById from the same computation,
  // so the scene always renders a consistent (positions, node-data) pair.

  createEffect(() => {
    if (!rendererReady() || !r3) return
    const snap = layoutSnap()
    const selectedId = state.selectedNodeId
    const overlay = diffOverlay()
    const isDark = resolvedTheme() === 'dark'

    r3.setBackground(isDark ? 0x030712 : 0xf1f5f9)

    if (!snap) return

    if (pendingAnchor) {
      // Anchor: keep the container's top-left at the same screen position
      // so expand/collapse doesn't shuffle the graph around.
      const anchor = pendingAnchor
      pendingAnchor = null
      const allContainers = [
        ...snap.result.containers,
        ...snap.result.classContainers,
        ...snap.result.dirContainers,
        ...snap.result.packageContainers
      ]
      const cont = allContainers.find((c) => c.id === anchor.containerId)
      if (cont) {
        // untrack: read cam without making this effect reactive to camera changes
        const { zoom } = untrack(cam)
        const newPanX = anchor.screenX - cont.x * zoom
        const newPanY = anchor.screenY - cont.y * zoom
        setCam({ panX: newPanX, panY: newPanY, zoom })
        r3.applyCamera(newPanX, newPanY, zoom)
      }
    } else if (needsFit) {
      needsFit = false
      const fit = r3.fitLayout(snap.result.width, snap.result.height)
      setCam({ panX: fit.panX, panY: fit.panY, zoom: fit.zoom })
      r3.applyCamera(fit.panX, fit.panY, fit.zoom)
    }

    r3.updateScene(snap.result, snap.nodeById, selectedId, overlay, isDark)
  })

  // ── Camera sync effect ──────────────────────────────────────────────────────

  createEffect(() => {
    if (!rendererReady() || !r3) return
    const { panX, panY, zoom } = cam()
    r3.applyCamera(panX, panY, zoom)
    r3.render()
  })

  // ── Theme background sync ───────────────────────────────────────────────────

  createEffect(() => {
    if (!rendererReady() || !r3) return
    r3.setBackground(resolvedTheme() === 'dark' ? 0x030712 : 0xf1f5f9)
    r3.render()
  })

  // ── Container screen rect (for expand/collapse button positioning) ──────────

  const containerScreenRect = createMemo(() => {
    const td = tooltipData()
    if (td?.kind !== 'container') return null
    if (!r3) return null
    // Only show the expand/collapse button for containers that have a filePath —
    // class sub-containers and contract groups lack one and cannot be toggled
    // via expandedGroups (isGroupExpanded matches on filePath, not id).
    const fp = (td as ContainerTooltip).filePath
    if (!fp) return null
    const fc = r3.getContainerWorldRect(td.id)
    if (!fc) return null
    const { panX, panY, zoom } = cam()
    return {
      x: fc.x * zoom + panX,
      y: fc.y * zoom + panY,
      w: fc.width * zoom,
      h: fc.height * zoom,
      collapsed: fc.collapsed ?? false,
      id: td.id,
      label: td.label,
      filePath: fp
    }
  })

  // ── Mount: init Three.js renderer ──────────────────────────────────────────

  onMount(() => {
    if (!canvasRef || !wrapperRef) return

    const renderer = new ThreeRenderer(canvasRef)
    r3 = renderer

    const w = canvasRef.clientWidth || wrapperRef.clientWidth || 800
    const h = canvasRef.clientHeight || wrapperRef.clientHeight || 600
    renderer.resize(w, h)
    renderer.setBackground(resolvedTheme() === 'dark' ? 0x030712 : 0xf1f5f9)
    renderer.render()

    setRendererReady(true)
    void loadAnnotations()

    // ── ResizeObserver ──────────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) {
          renderer.resize(width, height)
          renderer.render()
        }
      }
    })
    if (wrapperRef) ro.observe(wrapperRef)
    onCleanup(() => ro.disconnect())
  })

  // ── Pan / zoom / draw ───────────────────────────────────────────────────────

  /** Live stroke while the user drags in annotate mode, world coords. */
  const [stroke, setStroke] = createSignal<Point[]>([])
  /** Nodes the polyline gesture has passed through, in order. */
  const [strokeNodes, setStrokeNodes] = createSignal<string[]>([])

  let isPanning = false
  let panStart = { x: 0, y: 0 }
  let camAtPanStart = { panX: 0, panY: 0, zoom: 1 }
  let didPan = false

  // Drawing gesture state
  let isDrawing = false
  /** True when the drag began on a node — that makes it a polyline, not a lasso. */
  let drawStartedOnNode = false

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const { panX, panY, zoom } = cam()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.max(0.05, Math.min(50, zoom * delta))
    const newPanX = mx - (mx - panX) * (newZoom / zoom)
    const newPanY = my - (my - panY) * (newZoom / zoom)
    setCam({ panX: newPanX, panY: newPanY, zoom: newZoom })
  }

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return

    // In annotate mode a left-drag draws instead of panning. Which shape it
    // produces depends only on where the drag begins — node or empty canvas.
    // Drawing never depends on the graph having laid out: a user can always
    // enclose empty space or drop a pin on a blank canvas.
    if (interactionMode() === 'annotate') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const { panX, panY, zoom } = cam()
      const wx = (mx - panX) / zoom
      const wy = (my - panY) / zoom

      // Hit testing only works once the renderer and a layout exist; without
      // them every gesture simply starts from empty canvas.
      const hit = r3 && layoutSnap() ? r3.hitTest(mx, my, panX, panY, zoom) : null

      isDrawing = true
      drawStartedOnNode = hit?.kind === 'node'
      setStroke([[wx, wy]])

      if (hit?.kind === 'node') {
        const gn = layoutSnap()?.nodeById.get(hit.id)
        setStrokeNodes(gn ? [nodeSemanticId(gn)] : [])
      } else {
        setStrokeNodes([])
      }
      return
    }

    isPanning = true
    didPan = false
    panStart = { x: e.clientX, y: e.clientY }
    camAtPanStart = cam()
  }

  // ── Mouse move: pan + hover hit-testing ────────────────────────────────────

  const onMouseMove = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Drawing takes precedence — accumulate the stroke and, for a polyline,
    // pick up every node the pointer crosses in the order it crosses them.
    if (isDrawing) {
      const { panX, panY, zoom } = cam()
      const wx = (mx - panX) / zoom
      const wy = (my - panY) / zoom
      setStroke((prev) => [...prev, [wx, wy] as Point])

      if (drawStartedOnNode && r3) {
        const hit = r3.hitTest(mx, my, panX, panY, zoom)
        if (hit?.kind === 'node') {
          const gn = layoutSnap()?.nodeById.get(hit.id)
          if (gn) {
            const semId = nodeSemanticId(gn)
            setStrokeNodes((prev) => (prev.includes(semId) ? prev : [...prev, semId]))
          }
        }
      }
      setMousePos({ x: mx, y: my })
      return
    }

    if (isPanning) {
      const dx = e.clientX - panStart.x
      const dy = e.clientY - panStart.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didPan = true
      setCam({
        panX: camAtPanStart.panX + dx,
        panY: camAtPanStart.panY + dy,
        zoom: camAtPanStart.zoom
      })
      return
    }

    // Hover hit-testing — only when not panning
    setMousePos({ x: mx, y: my })
    if (!r3 || !layoutSnap()) return

    const { panX, panY, zoom } = cam()
    const hit = r3.hitTest(mx, my, panX, panY, zoom)

    if (hit !== null) {
      // Node or container hit — no edge test needed
      applyHover(hit, -1)
    } else {
      // No node/container — test edge proximity
      const wx = (mx - panX) / zoom
      const wy = (my - panY) / zoom
      const edgeIdx = r3.edgeHitTest(wx, wy, zoom)
      applyHover(null, edgeIdx)
    }
  }

  const applyHover = (hit: HitResult | null, edgeIdx: number) => {
    if (!r3) return
    const snap = layoutSnap()

    if (hit?.kind === 'node') {
      r3.setHovered(hit.id, null, -1)
      setCursor('pointer')
      const gn = snap?.nodeById.get(hit.id)
      setTooltipData({ kind: 'node', id: hit.id, name: hit.label, nodeKind: gn?.kind ?? hit.nodeKind })
    } else if (hit?.kind === 'container') {
      r3.setHovered(null, hit.id, -1)
      setCursor(hit.collapsed ? 'pointer' : 'default')
      setTooltipData({
        kind: 'container',
        id: hit.id,
        label: hit.label,
        collapsed: hit.collapsed,
        filePath: hit.filePath
      })
    } else if (edgeIdx >= 0) {
      r3.setHovered(null, null, edgeIdx)
      setCursor('default')
      const ed = r3.getEdgeData(edgeIdx)
      if (ed) {
        const srcName = snap?.nodeById.get(ed.source)?.name ?? ed.source
        const tgtName = snap?.nodeById.get(ed.target)?.name ?? ed.target
        setTooltipData({ kind: 'edge', id: ed.id, edgeKind: ed.kind, source: srcName, target: tgtName })
      } else {
        setTooltipData(null)
      }
    } else {
      r3.setHovered(null, null, -1)
      setCursor('default')
      setTooltipData(null)
    }
  }

  const onMouseLeave = () => {
    if (r3) r3.setHovered(null, null, -1)
    setCursor('default')
    setTooltipData(null)
  }

  // ── Drawing: resolve the gesture into a pending shape ──────────────────────

  /** Node centres in world coords, for lasso capture. */
  const nodeCentres = (): Array<{ semId: string; x: number; y: number }> => {
    const snap = layoutSnap()
    if (!snap) return []
    const out: Array<{ semId: string; x: number; y: number }> = []
    for (const [layoutId, ln] of snap.result.nodes) {
      const gn = snap.nodeById.get(layoutId)
      if (!gn) continue
      out.push({ semId: nodeSemanticId(gn), x: ln.x + ln.width / 2, y: ln.y + ln.height / 2 })
    }
    return out
  }

  /**
   * Turn the finished gesture into a pending annotation.
   *
   * The gesture alone decides the shape — the user never picks one:
   *   started on a node + moved  → polyline through the nodes crossed
   *   started on empty + moved   → region enclosing the lassoed nodes
   *   barely moved               → point
   */
  const finishDrawing = () => {
    const raw = stroke()
    const simplified = simplifyStroke(raw)

    // Total travel decides drag vs click, independent of sample count
    let travel = 0
    for (let i = 1; i < raw.length; i++) {
      travel += Math.hypot(raw[i]![0] - raw[i - 1]![0], raw[i]![1] - raw[i - 1]![1])
    }
    const isDrag = travel > 8 / cam().zoom

    const last = raw[raw.length - 1] ?? [0, 0]

    if (!isDrag) {
      // A tap — drop a point where the user clicked
      setPendingAnnotation({
        shape: 'point',
        points: [],
        anchor: { x: last[0], y: last[1] },
        members: strokeNodes()
      })
    } else if (drawStartedOnNode) {
      const members = strokeNodes()
      setPendingAnnotation({
        shape: 'polyline',
        points: simplified,
        anchor: { x: simplified[0]?.[0] ?? last[0], y: simplified[0]?.[1] ?? last[1] },
        members
      })
    } else {
      // Lasso — everything whose centre falls inside the closed outline
      const captured = nodeCentres()
        .filter((n) => pointInPolygon(n.x, n.y, simplified))
        .map((n) => n.semId)
      setPendingAnnotation({
        shape: 'region',
        points: simplified,
        anchor: centroid(simplified),
        members: captured
      })
    }

    isDrawing = false
    drawStartedOnNode = false
    setStroke([])
    setStrokeNodes([])
  }

  /** Commit the pending shape under the kind the user typed. */
  const commitPendingAnnotation = (kind: string, label: string) => {
    const pending = pendingAnnotation()
    if (!pending) return

    const trimmedKind = kind.trim()
    const finalLabel = label.trim() || trimmedKind || 'Untitled'

    void addAnnotation(pending.shape, finalLabel, pending.members, {
      kind: trimmedKind,
      geometry: { points: pending.points, anchor: pending.anchor }
    })

    clearPendingAnnotation()
    setInteractionMode('select')
  }

  const cancelPendingAnnotation = () => {
    clearPendingAnnotation()
    setStroke([])
    setStrokeNodes([])
    isDrawing = false
    drawStartedOnNode = false
  }

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return

    if (isDrawing) {
      finishDrawing()
      return
    }

    const wasPanning = isPanning && didPan
    isPanning = false
    didPan = false
    if (wasPanning || !r3) return

    if (!layoutSnap()) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { panX, panY, zoom } = cam()
    const hit = r3.hitTest(mx, my, panX, panY, zoom)

    if (hit?.kind === 'node') {
      void selectNode(hit.id)
    } else {
      clearFocus()
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      ref={wrapperRef}
      class="relative flex-1 overflow-hidden bg-slate-100 dark:bg-gray-950 select-none"
      data-testid="graph-canvas"
      style={{ cursor: cursor() }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
    >
      <canvas ref={canvasRef} class="w-full h-full block" data-testid="graph-webgl-canvas" />

      <AnnotationOverlay
        panX={cam().panX}
        panY={cam().panY}
        zoom={cam().zoom}
        layoutNodes={layoutSnap()?.result.nodes ?? null}
        semanticToLayoutId={semanticToLayoutId()}
      />

      {/* Live drawing stroke + committed-but-unnamed shape preview */}
      <Show when={stroke().length > 1 || pendingAnnotation()}>
        <svg class="absolute inset-0 w-full h-full pointer-events-none" style={{ 'z-index': 25 }}>
          <g transform={`translate(${cam().panX}, ${cam().panY}) scale(${cam().zoom})`}>
            {/* In-progress stroke */}
            <Show when={stroke().length > 1}>
              <polyline
                points={stroke()
                  .map(([x, y]) => `${x},${y}`)
                  .join(' ')}
                fill={drawStartedOnNode ? 'none' : 'rgba(59,130,246,0.08)'}
                stroke="#3b82f6"
                stroke-width={2 / cam().zoom}
                stroke-dasharray={`${4 / cam().zoom} ${3 / cam().zoom}`}
                stroke-linejoin="round"
                stroke-linecap="round"
                data-testid="draw-stroke"
              />
            </Show>

            {/* Drawn shape awaiting a name */}
            <Show when={pendingAnnotation()}>
              {(p) => (
                <Show
                  when={p().shape !== 'point'}
                  fallback={
                    <circle cx={p().anchor.x} cy={p().anchor.y} r={7 / cam().zoom} fill="#3b82f6" fill-opacity="0.85" />
                  }
                >
                  <polyline
                    points={p()
                      .points.map(([x, y]) => `${x},${y}`)
                      .join(' ')}
                    fill={p().shape === 'region' ? 'rgba(59,130,246,0.10)' : 'none'}
                    stroke="#3b82f6"
                    stroke-width={2.5 / cam().zoom}
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </Show>
              )}
            </Show>
          </g>
        </svg>
      </Show>

      {/* Inline kind naming — appears at the shape anchor, never a modal */}
      <Show when={pendingAnnotation()}>
        {(p) => (
          <KindInput
            x={Math.max(
              8,
              Math.min(p().anchor.x * cam().zoom + cam().panX + 12, (wrapperRef?.clientWidth ?? 800) - 270)
            )}
            y={Math.max(
              8,
              Math.min(p().anchor.y * cam().zoom + cam().panY + 12, (wrapperRef?.clientHeight ?? 600) - 230)
            )}
            shape={p().shape}
            memberCount={p().members.length}
            onCommit={commitPendingAnnotation}
            onCancel={cancelPendingAnnotation}
          />
        )}
      </Show>

      {/* Layout loading spinner */}
      <Show when={isLayouting()}>
        <div class="absolute top-2 left-1/2 -translate-x-1/2 bg-white/80 dark:bg-gray-900/80 text-xs text-gray-500 dark:text-gray-400 px-3 py-1 rounded-full shadow pointer-events-none">
          Laying out…
        </div>
      </Show>

      {/* Layout error */}
      <Show when={layoutError()}>
        {(msg) => (
          <div class="absolute top-2 left-1/2 -translate-x-1/2 max-w-sm bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 text-xs px-3 py-2 rounded shadow text-center pointer-events-none">
            {msg()}
          </div>
        )}
      </Show>

      {/* Empty state */}
      <Show when={!isLayouting() && state.viewNodes.length === 0 && !state.isLoading}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm pointer-events-none">
          {state.projectRoot ? 'No nodes match the current filters.' : 'Open a project to get started.'}
        </div>
      </Show>

      {/* ── Expand/collapse button anchored to hovered container ── */}
      <Show when={containerScreenRect()}>
        {(sr) => {
          // Position button at top-right of container; for chips, center-right.
          const btnX = () => Math.min(sr().x + sr().w - 4, (wrapperRef?.clientWidth ?? 800) - 90)
          const btnY = () => Math.max(sr().collapsed ? sr().y + sr().h / 2 - 12 : sr().y + 4, 4)
          return (
            <button
              data-testid="container-expand-btn"
              class="absolute z-40 flex items-center gap-1 text-xs px-2 py-1 rounded shadow
                     bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              style={{ left: `${btnX() - 76}px`, top: `${btnY()}px` }}
              onMouseMove={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                // Record the container's current screen-space top-left so the
                // scene effect can re-anchor the camera after ELK resolves.
                pendingAnchor = {
                  containerId: sr().id,
                  screenX: sr().x,
                  screenY: sr().y
                }
                if (sr().collapsed) {
                  addGroupExpanded(sr().filePath)
                } else {
                  collapseGroup(sr().filePath)
                }
              }}
            >
              {sr().collapsed ? '+ Expand' : '- Collapse'}
            </button>
          )
        }}
      </Show>

      {/* ── Tooltip ── */}
      <Show when={tooltipData()}>
        {(data) => {
          // Clamp tooltip to stay within the wrapper bounds.
          const tipX = () => {
            const w = wrapperRef?.clientWidth ?? 800
            return mousePos().x + 14 > w - 200 ? mousePos().x - 190 : mousePos().x + 14
          }
          const tipY = () => Math.max(mousePos().y - 10, 4)
          return (
            <div
              class="absolute z-50 pointer-events-none max-w-xs rounded shadow-lg
                     bg-gray-900/95 dark:bg-gray-950/95 text-white text-xs px-2.5 py-2"
              style={{ left: `${tipX()}px`, top: `${tipY()}px` }}
            >
              <Switch>
                <Match when={data().kind === 'node'}>
                  <div class="font-semibold leading-snug">{(data() as NodeTooltip).name}</div>
                  <Show when={(data() as NodeTooltip).nodeKind}>
                    <div class="text-gray-400 mt-0.5">{(data() as NodeTooltip).nodeKind}</div>
                  </Show>
                </Match>
                <Match when={data().kind === 'container'}>
                  <div class="font-semibold leading-snug truncate max-w-[180px]">
                    {(data() as ContainerTooltip).label}
                  </div>
                  <div class="text-blue-400 mt-0.5">
                    {(data() as ContainerTooltip).collapsed
                      ? 'click or use button to expand'
                      : 'use button to collapse'}
                  </div>
                </Match>
                <Match when={data().kind === 'edge'}>
                  <Show when={(data() as EdgeTooltip).edgeKind}>
                    <div class="text-gray-400 mb-0.5">{(data() as EdgeTooltip).edgeKind}</div>
                  </Show>
                  <div class="font-mono leading-snug truncate max-w-[200px]">
                    {(data() as EdgeTooltip).source} <span class="text-gray-500">→</span>{' '}
                    {(data() as EdgeTooltip).target}
                  </div>
                </Match>
              </Switch>
            </div>
          )
        }}
      </Show>

      {/* ── Annotate mode hint ── */}
      <Show when={interactionMode() === 'annotate' && !pendingAnnotation()}>
        <div
          class="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3
                    bg-gray-900/90 dark:bg-gray-800/90 text-white text-xs px-4 py-2 rounded-lg shadow-lg"
          data-testid="annotate-hint"
        >
          <span class="font-semibold">Annotate</span>
          <span class="text-gray-400">drag empty space to enclose · drag from a node to trace · click to pin</span>
          <button
            class="text-gray-400 hover:text-white"
            onClick={(e) => {
              e.stopPropagation()
              cancelPendingAnnotation()
              setInteractionMode('select')
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            Esc
          </button>
        </div>
      </Show>
    </div>
  )
}

// Needed by elk.ts hitTest — keep the GraphNode type accessible without
// re-exporting from a component file.
export type { GraphNode }
