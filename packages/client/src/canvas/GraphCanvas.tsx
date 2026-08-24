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
  Show,
  Switch,
  Match
} from 'solid-js'
import type { GraphNode } from '@graphcoder/core'
import { layoutGraph, type LayoutResult } from '../layout/elk.js'
import { clearFocus, selectNode, state, toggleGroupExpanded } from '../state/store.js'
import { resolvedTheme } from '../state/theme.js'
import type { DiffOverlay, HitResult } from './ThreeRenderer.js'
import { ThreeRenderer } from './ThreeRenderer.js'

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

  // ── Reactive memos ──────────────────────────────────────────────────────────

  const diffOverlay = createMemo((): DiffOverlay => {
    const diff = state.currentDiff
    if (!diff) return { added: new Set<string>(), modified: new Set<string>(), moved: new Set<string>() }
    const added = new Set<string>()
    const modified = new Set<string>()
    const moved = new Set<string>()
    for (const op of diff.operations) {
      if (op.op === 'add_node') added.add(op.node.id)
      else if (op.op === 'modify_node') modified.add(op.id)
      else if (op.op === 'move_node') moved.add(op.id)
    }
    return { added, modified, moved }
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
  const MAX_LAYOUT_NODES = 1000

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

    if (needsFit) {
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
      filePath: (td as ContainerTooltip).filePath
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

  // ── Pan / zoom ──────────────────────────────────────────────────────────────

  let isPanning = false
  let panStart = { x: 0, y: 0 }
  let camAtPanStart = { panX: 0, panY: 0, zoom: 1 }
  let didPan = false

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

  // ── Click: select node or toggle container expand ───────────────────────────

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return
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
    } else if (hit?.kind === 'container' && hit.collapsed) {
      // Clicking a collapsed chip expands it — key must be filePath, not id
      toggleGroupExpanded(hit.filePath ?? hit.id)
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
              class="absolute z-40 flex items-center gap-1 text-xs px-2 py-1 rounded shadow
                     bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              style={{ left: `${btnX() - 76}px`, top: `${btnY()}px` }}
              onClick={(e) => {
                e.stopPropagation()
                toggleGroupExpanded(sr().filePath ?? sr().id)
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
    </div>
  )
}

// Needed by elk.ts hitTest — keep the GraphNode type accessible without
// re-exporting from a component file.
export type { GraphNode }
