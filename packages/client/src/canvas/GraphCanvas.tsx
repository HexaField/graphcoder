/**
 * GraphCanvas — SolidJS wrapper around ThreeRenderer.
 *
 * Reactive interface:
 *   - ELK layout effect: re-runs when the server sends a new view_snapshot
 *     (viewNodes / viewEdges / viewGroups) or the layout direction changes.
 *   - Camera fit on first layout.
 *   - Scene update effect (selection, diff overlay, theme).
 *   - Pan/zoom via wheel + mouse drag.
 *   - Click hit testing via RBush.
 *
 * All filtering and group computation runs server-side (core computeView).
 * This component receives pre-filtered data and forwards it straight to ELK.
 */

import { type Component, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { GraphNode } from '@graphcoder/core'
import { layoutGraph, type LayoutResult } from '../layout/elk.js'
import { clearFocus, selectNode, state } from '../state/store.js'
import { resolvedTheme } from '../state/theme.js'
import type { DiffOverlay } from './ThreeRenderer.js'
import { ThreeRenderer } from './ThreeRenderer.js'

/** Layout result paired with the node lookup used to produce it.
 *  Keeping them together prevents rendering with a mismatched (layout, nodeById)
 *  pair during the async window between a viewNodes update and ELK resolving. */
interface LayoutSnap {
  result: LayoutResult
  nodeById: Map<string, GraphNode>
}

// ── GraphCanvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Camera state: pan offset (world coords → screen) + zoom
  const [cam, setCam] = createSignal({ panX: 0, panY: 0, zoom: 1 })
  const [rendererReady, setRendererReady] = createSignal(false)
  const [layoutError, setLayoutError] = createSignal<string | null>(null)

  let canvasRef: HTMLCanvasElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  let r3: ThreeRenderer | null = null

  // Track whether the current layout has been camera-fitted already.
  // Reset to false on each layout change so we only auto-fit once.
  let needsFit = false

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
      needsFit = true
    }

    try {
      const result = await layoutGraph(nodes, edges, direction, groups)
      if (ver === layoutVersion) {
        // Pair the result with the exact nodeById that produced it — prevents the
        // scene from rendering a mismatched (layout, nodeById) pair during the
        // async gap between a viewNodes update and ELK resolving.
        setLayoutSnap({ result, nodeById: new Map(nodes.map((n) => [n.id, n])) })
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

  const onMouseMove = (e: MouseEvent) => {
    if (!isPanning) return
    const dx = e.clientX - panStart.x
    const dy = e.clientY - panStart.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didPan = true
    setCam({
      panX: camAtPanStart.panX + dx,
      panY: camAtPanStart.panY + dy,
      zoom: camAtPanStart.zoom
    })
  }

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return
    const wasPanning = isPanning && didPan
    isPanning = false
    didPan = false
    if (wasPanning || !r3) return

    // Click — hit-test against the last rendered layout (rbush is populated by updateScene).
    if (!layoutSnap()) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { panX, panY, zoom } = cam()
    const hit = r3.hitTest(mx, my, panX, panY, zoom)
    if (hit) {
      selectNode(hit)
    } else {
      clearFocus()
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      ref={wrapperRef}
      class="relative flex-1 overflow-hidden bg-slate-100 dark:bg-gray-950 select-none"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <canvas ref={canvasRef} class="w-full h-full block" />

      {/* Layout loading spinner */}
      <Show when={isLayouting()}>
        <div class="absolute top-2 left-1/2 -translate-x-1/2 bg-white/80 dark:bg-gray-900/80 text-xs text-gray-500 dark:text-gray-400 px-3 py-1 rounded-full shadow">
          Laying out…
        </div>
      </Show>

      {/* Layout error */}
      <Show when={layoutError()}>
        {(msg) => (
          <div class="absolute top-2 left-1/2 -translate-x-1/2 max-w-sm bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 text-xs px-3 py-2 rounded shadow text-center">
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
    </div>
  )
}

// Needed by elk.ts hitTest — keep the GraphNode type accessible without
// re-exporting from a component file.
export type { GraphNode }
