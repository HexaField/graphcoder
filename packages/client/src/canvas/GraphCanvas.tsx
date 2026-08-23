import { type Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { GraphNode } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import { layoutGraph, type LayoutEdge, type LayoutNode, type LayoutResult } from '../layout/elk.js'
import { clearFocus, selectNode, state, visibleGraph } from '../state/store.js'

type DiffStatus = 'added' | 'modified' | 'moved' | 'none'

function diffStatusStroke(status: DiffStatus): string {
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

// ── Sub-components ────────────────────────────────────────────────────────────

interface NodeRectProps {
  layoutNode: LayoutNode
  graphNode: GraphNode | undefined
  selected: boolean
  diffStatus: DiffStatus
  onClick: () => void
}

const NodeRect: Component<NodeRectProps> = (props) => {
  const label = () => {
    const name = props.graphNode?.name ?? props.layoutNode.id
    return name.length > 18 ? `${name.slice(0, 16)}…` : name
  }

  return (
    <g
      transform={`translate(${props.layoutNode.x}, ${props.layoutNode.y})`}
      onClick={props.onClick}
      style="cursor: pointer"
      data-testid={`node-${props.layoutNode.id}`}
      data-nodeid={props.layoutNode.id}
    >
      {/* Diff overlay ring — rendered first so it sits behind the node fill */}
      <Show when={props.diffStatus !== 'none'}>
        <rect
          x={-3}
          y={-3}
          width={props.layoutNode.width + 6}
          height={props.layoutNode.height + 6}
          fill="none"
          stroke={diffStatusStroke(props.diffStatus)}
          stroke-width={2.5}
          rx={6}
          opacity={0.85}
        />
      </Show>
      <rect
        width={props.layoutNode.width}
        height={props.layoutNode.height}
        fill={nodeKindColor(props.graphNode?.kind)}
        stroke={props.selected ? '#3b82f6' : 'transparent'}
        stroke-width={props.selected ? 2 : 0}
        rx={4}
      />
      {/* kind badge */}
      <text
        x={props.layoutNode.width - 4}
        y={10}
        fill="#6b7280"
        font-size="8"
        font-family="monospace"
        text-anchor="end"
      >
        {props.graphNode?.kind ?? ''}
      </text>
      {/* name label */}
      <text x={8} y={props.layoutNode.height / 2 + 4} fill="white" font-size="11" font-family="monospace">
        {label()}
      </text>
    </g>
  )
}

interface EdgeLineProps {
  edge: LayoutEdge
}

const EdgeLine: Component<EdgeLineProps> = (props) => {
  const pointsStr = () => {
    const pts: string[] = []
    for (const section of props.edge.sections) {
      pts.push(`${section.startPoint.x},${section.startPoint.y}`)
      for (const bp of section.bendPoints ?? []) {
        pts.push(`${bp.x},${bp.y}`)
      }
      pts.push(`${section.endPoint.x},${section.endPoint.y}`)
    }
    return pts.join(' ')
  }

  return (
    <polyline
      points={pointsStr()}
      fill="none"
      stroke={edgeKindColor(props.edge.kind)}
      stroke-width="1.5"
      opacity="0.6"
      marker-end="url(#arrowhead)"
    />
  )
}

// ── Main canvas ───────────────────────────────────────────────────────────────

export const GraphCanvas: Component = () => {
  const [layout, setLayout] = createSignal<LayoutResult | null>(null)
  const [isLayouting, setIsLayouting] = createSignal(false)
  // Transform-based camera: no viewBox, no preserveAspectRatio math.
  // Pan is tx += movementX (exact 1:1). Zoom pivots around cursor.
  const [camera, setCamera] = createSignal({ tx: 0, ty: 0, scale: 1 })

  let svgRef: SVGSVGElement | undefined

  // Memo so that filter/focus changes invalidate the layout exactly once per tick
  const visible = createMemo(visibleGraph)

  // O(1) node lookup by id — avoids O(n²) find() inside the For factory
  const nodeById = createMemo(() => new Map(state.nodes.map((n) => [n.id, n])))

  // Diff overlay: set of semantic IDs per change type.
  // Only computed when a diff is active — skips SHA-256 hashing otherwise.
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

  // Recompute layout when visible nodes / edges / viewMode change.
  // After layout, fit-and-centre the graph in the SVG element.
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
      const pad = 40
      const svgW = svgRef?.clientWidth ?? 800
      const svgH = svgRef?.clientHeight ?? 600
      const scale = Math.min(svgW / (result.width + pad), svgH / (result.height + pad))
      const tx = (svgW - result.width * scale) / 2
      const ty = (svgH - result.height * scale) / 2
      setCamera({ tx, ty, scale })
    } finally {
      setIsLayouting(false)
    }
  })

  // ── Pan / zoom ──────────────────────────────────────────────────────────────
  //
  // No viewBox coordinate conversion — screen pixels map directly to tx/ty.
  // mousemove/mouseup attach to window so fast drags never lose tracking.

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

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (!svgRef) return
    const rect = svgRef.getBoundingClientRect()
    // Cursor position relative to SVG origin
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

  onMount(() => {
    if (!svgRef) return
    svgRef.addEventListener('wheel', handleWheel, { passive: false })
    onCleanup(() => {
      svgRef?.removeEventListener('wheel', handleWheel)
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
    })
  })

  return (
    <div class="relative w-full h-full bg-gray-950 overflow-hidden select-none" data-testid="graph-canvas">
      <Show when={isLayouting()}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-400 z-10">
          <span>Computing layout…</span>
        </div>
      </Show>
      <Show when={state.nodes.length === 0 && !state.isLoading}>
        <div class="absolute inset-0 flex items-center justify-center text-gray-500">
          <span>No project open. Enter a project path above.</span>
        </div>
      </Show>
      <svg ref={svgRef} class="w-full h-full" data-testid="graph-svg" onMouseDown={handleMouseDown}>
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#4b5563" />
          </marker>
        </defs>
        {/*
          Background hit target at screen coords — clicking empty canvas clears focus.
          Lives OUTSIDE the camera group so it always fills the SVG element exactly.
        */}
        <rect width="100%" height="100%" fill="transparent" onClick={clearFocus} />
        {/* All graph content lives inside this transform — pan+zoom via tx/ty/scale */}
        <g transform={`translate(${camera().tx}, ${camera().ty}) scale(${camera().scale})`}>
          <g data-testid="graph-edges">
            <For each={layout()?.edges ?? []}>{(edge) => <EdgeLine edge={edge} />}</For>
          </g>
          <g data-testid="graph-nodes">
            <For each={layout() ? [...layout()!.nodes.values()] : []}>
              {(node) => {
                // O(1) lookup — nodeById memo is a Map over state.nodes
                const graphNode = nodeById().get(node.id)
                // SHA-256 only runs when a diff is active (diffOverlay returns empty Sets otherwise)
                const semId = state.currentDiff && graphNode ? nodeSemanticId(graphNode) : null
                const diffStatus = nodeDiffStatus(semId, diffOverlay())
                return (
                  <NodeRect
                    layoutNode={node}
                    graphNode={graphNode}
                    selected={state.selectedNodeId === node.id}
                    diffStatus={diffStatus}
                    onClick={() => void selectNode(node.id)}
                  />
                )
              }}
            </For>
          </g>
        </g>
      </svg>
    </div>
  )
}
