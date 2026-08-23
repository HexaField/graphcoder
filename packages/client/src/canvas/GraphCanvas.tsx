import { type Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { GraphNode } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import { layoutGraph, type LayoutEdge, type LayoutNode, type LayoutResult } from '../layout/elk.js'
import { clearFocus, selectNode, state, visibleGraph } from '../state/store.js'

// ── Types ─────────────────────────────────────────────────────────────────────

type DiffStatus = 'added' | 'modified' | 'moved' | 'none'

interface OverlayNode {
  id: string
  name: string
  left: number
  top: number
  width: number
  height: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function diffStatusColor(status: DiffStatus): string {
  if (status === 'added') return '#22c55e'
  if (status === 'modified') return '#f59e0b'
  if (status === 'moved') return '#06b6d4'
  return 'transparent'
}

function nodeDiffStatus(
  semId: string | null,
  overlay: { added: Set<string>; modified: Set<string>; moved: Set<string> }
): DiffStatus {
  if (!semId) return 'none'
  if (overlay.added.has(semId)) return 'added'
  if (overlay.modified.has(semId)) return 'modified'
  if (overlay.moved.has(semId)) return 'moved'
  return 'none'
}

/** Destroy all direct children of a container and free GPU resources. */
function clearContainer(c: Container): void {
  const removed = c.removeChildren()
  for (const child of removed) {
    child.destroy({ children: true })
  }
}

// ── Shared text styles ─────────────────────────────────────────────────────────
// Allocated once per module; reused across every Text object in the scene to
// share glyph cache and avoid per-text style allocation.

const NAME_STYLE = new TextStyle({ fontSize: 11, fill: 'white', fontFamily: 'monospace' })
const BADGE_STYLE = new TextStyle({ fontSize: 8, fill: '#6b7280', fontFamily: 'monospace' })

// ── Draw functions ────────────────────────────────────────────────────────────

function drawEdge(target: Container, edge: LayoutEdge): void {
  const pts: number[] = []
  for (const section of edge.sections) {
    pts.push(section.startPoint.x, section.startPoint.y)
    for (const bp of section.bendPoints ?? []) {
      pts.push(bp.x, bp.y)
    }
    pts.push(section.endPoint.x, section.endPoint.y)
  }
  if (pts.length < 4) return

  const color = edgeKindColor(edge.kind)
  const g = new Graphics()

  // Polyline
  g.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) {
    g.lineTo(pts[i], pts[i + 1])
  }
  g.stroke({ color, width: 1.5, alpha: 0.6 })

  // Filled arrowhead at the end point
  const n = pts.length
  const ex = pts[n - 2]
  const ey = pts[n - 1]
  const px = pts[n - 4]
  const py = pts[n - 3]
  const angle = Math.atan2(ey - py, ex - px)
  const aLen = 8
  g.moveTo(ex, ey)
  g.lineTo(ex - aLen * Math.cos(angle - 0.4), ey - aLen * Math.sin(angle - 0.4))
  g.lineTo(ex - aLen * Math.cos(angle + 0.4), ey - aLen * Math.sin(angle + 0.4))
  g.closePath()
  g.fill(color)

  target.addChild(g)
}

function drawNode(
  target: Container,
  layoutNode: LayoutNode,
  graphNode: GraphNode | undefined,
  selected: boolean,
  diffStatus: DiffStatus
): void {
  const { x, y, width, height } = layoutNode
  const g = new Graphics()

  // Diff overlay ring (drawn first so it sits behind the node fill)
  if (diffStatus !== 'none') {
    g.roundRect(-3, -3, width + 6, height + 6, 6)
    g.stroke({ color: diffStatusColor(diffStatus), width: 2.5, alpha: 0.85 })
  }

  // Node background
  g.roundRect(0, 0, width, height, 4)
  g.fill(nodeKindColor(graphNode?.kind))

  // Selection border — re-define path so fill and stroke stay independent
  if (selected) {
    g.roundRect(0, 0, width, height, 4)
    g.stroke({ color: '#3b82f6', width: 2 })
  }

  g.position.set(x, y)
  target.addChild(g)

  // Kind badge — right-aligned via anchor
  const badgeStr = graphNode?.kind ?? ''
  if (badgeStr) {
    const badge = new Text({ text: badgeStr, style: BADGE_STYLE })
    badge.anchor.set(1, 0) // right-top origin
    badge.position.set(x + width - 4, y + 2)
    target.addChild(badge)
  }

  // Name label — left edge, vertically centred via anchor
  const rawName = graphNode?.name ?? layoutNode.id
  const label = rawName.length > 18 ? `${rawName.slice(0, 16)}…` : rawName
  const nameText = new Text({ text: label, style: NAME_STYLE })
  nameText.anchor.set(0, 0.5)
  nameText.position.set(x + 8, y + height / 2)
  target.addChild(nameText)
}

// ── GraphCanvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [layout, setLayout] = createSignal<LayoutResult | null>(null)
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Camera signal drives both the Pixi world container and the DOM overlay.
  // All pan/zoom writes go through setCamera; Pixi reads it in a sync effect.
  const [camera, setCamera] = createSignal({ tx: 0, ty: 0, scale: 1 })
  const [pixiReady, setPixiReady] = createSignal(false)

  let canvasRef: HTMLCanvasElement | undefined
  let worldContainer: Container | null = null
  let edgeLayer: Container | null = null
  let nodeLayer: Container | null = null

  // ── Reactive memos ──────────────────────────────────────────────────────────

  const visible = createMemo(visibleGraph)
  const nodeById = createMemo(() => new Map(state.nodes.map((n) => [n.id, n])))

  const diffOverlay = createMemo(() => {
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

  // DOM overlay: one transparent button per node, pixel-positioned to match the
  // Pixi world. Playwright tests and screen readers use these; all rendering
  // happens in WebGL. pointer-events: none on the container; auto on each button.
  const overlayNodes = createMemo((): OverlayNode[] => {
    const l = layout()
    if (!l) return []
    const { tx, ty, scale } = camera()
    const byId = nodeById()
    return [...l.nodes.values()].map((n) => ({
      id: n.id,
      name: byId.get(n.id)?.name ?? n.id,
      left: n.x * scale + tx,
      top: n.y * scale + ty,
      width: n.width * scale,
      height: n.height * scale
    }))
  })

  // ── ELK layout effect ───────────────────────────────────────────────────────

  createEffect(async () => {
    const { nodes, edges } = visible()
    const viewMode = state.viewMode
    if (nodes.length === 0) {
      setLayout(null)
      return
    }
    setIsLayouting(true)
    try {
      const result = await layoutGraph(nodes, edges, viewMode)
      setLayout(result)
      // Fit-and-centre camera on every new layout
      const pad = 40
      const cw = canvasRef?.clientWidth ?? 800
      const ch = canvasRef?.clientHeight ?? 600
      const scale = Math.min(cw / (result.width + pad), ch / (result.height + pad))
      setCamera({
        tx: (cw - result.width * scale) / 2,
        ty: (ch - result.height * scale) / 2,
        scale
      })
    } finally {
      setIsLayouting(false)
    }
  })

  // ── Pixi draw effect ────────────────────────────────────────────────────────
  // Full scene redraw on layout, selection, or diff change.
  // Camera changes alone do NOT trigger a redraw — the camera sync effect
  // moves worldContainer.position directly (no GPU re-upload needed).

  createEffect(() => {
    if (!pixiReady() || !edgeLayer || !nodeLayer) return
    const l = layout()
    const selectedId = state.selectedNodeId
    const overlay = diffOverlay()
    const byId = nodeById()

    clearContainer(edgeLayer)
    clearContainer(nodeLayer)
    if (!l) return

    for (const edge of l.edges) {
      drawEdge(edgeLayer, edge)
    }
    for (const layoutNode of l.nodes.values()) {
      const graphNode = byId.get(layoutNode.id)
      const semId = state.currentDiff && graphNode ? nodeSemanticId(graphNode) : null
      const diffStatus = nodeDiffStatus(semId, overlay)
      drawNode(nodeLayer, layoutNode, graphNode, selectedId === layoutNode.id, diffStatus)
    }
  })

  // ── Camera sync ─────────────────────────────────────────────────────────────
  // Keeps the Pixi world container in sync with the camera signal.
  // Runs on every setCamera call — cheap: just two property writes, no redraws.

  createEffect(() => {
    if (!worldContainer) return
    const { tx, ty, scale } = camera()
    worldContainer.position.set(tx, ty)
    worldContainer.scale.set(scale)
  })

  // ── Pixi init ───────────────────────────────────────────────────────────────

  onMount(async () => {
    if (!canvasRef) return

    const app = new Application()
    await app.init({
      canvas: canvasRef,
      resizeTo: canvasRef.parentElement ?? undefined,
      background: '#030712', // gray-950
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true
    })

    const wc = new Container()
    const el = new Container() // edges — drawn before nodes
    const nl = new Container() // nodes
    wc.addChild(el, nl)
    app.stage.addChild(wc)

    worldContainer = wc
    edgeLayer = el
    nodeLayer = nl

    setPixiReady(true)

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvasRef!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const sensitivity = e.deltaMode === 0 ? 0.002 : 0.08
      const factor = Math.exp(-e.deltaY * sensitivity)
      setCamera((c) => ({
        scale: c.scale * factor,
        tx: cx - (cx - c.tx) * factor,
        ty: cy - (cy - c.ty) * factor
      }))
    }
    canvasRef.addEventListener('wheel', handleWheel, { passive: false })

    onCleanup(() => {
      canvasRef?.removeEventListener('wheel', handleWheel)
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      worldContainer = null
      edgeLayer = null
      nodeLayer = null
      app.destroy()
    })
  })

  // ── Pan ──────────────────────────────────────────────────────────────────────
  // movementX/Y maps 1:1 to tx/ty — no coordinate conversion needed.
  // Listeners attach to window so fast drags never lose tracking when the cursor
  // leaves the canvas.

  const onWindowMouseMove = (e: MouseEvent) => {
    setCamera((c) => ({ ...c, tx: c.tx + e.movementX, ty: c.ty + e.movementY }))
  }

  const onWindowMouseUp = () => {
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div class="relative w-full h-full overflow-hidden select-none" data-testid="graph-canvas">
      <Show when={isLayouting()}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-400 z-10 pointer-events-none">
          <span>Computing layout…</span>
        </div>
      </Show>
      <Show when={state.nodes.length === 0 && !state.isLoading}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-500 pointer-events-none">
          <span>No project open. Enter a project path above.</span>
        </div>
      </Show>

      {/* WebGL canvas — all rendering lives here. data-testid="graph-svg" kept
          for backward-compat with E2E tests that assert the element exists. */}
      <canvas
        ref={canvasRef}
        class="block w-full h-full"
        data-testid="graph-svg"
        onMouseDown={handleMouseDown}
        onClick={clearFocus}
      />

      {/* Invisible hit-test overlay.
          The container is pointer-events:none so background clicks pass through
          to the canvas. Each button is pointer-events:auto so tests and screen
          readers can interact with individual nodes. */}
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <For each={overlayNodes()}>
          {(n) => (
            <button
              class="absolute opacity-0 pointer-events-auto"
              style={{
                left: `${n.left}px`,
                top: `${n.top}px`,
                width: `${n.width}px`,
                height: `${n.height}px`
              }}
              data-nodeid={n.id}
              data-testid={`node-${n.id}`}
              onClick={(e) => {
                e.stopPropagation()
                void selectNode(n.id)
              }}
              aria-label={n.name}
            />
          )}
        </For>
      </div>
    </div>
  )
}
