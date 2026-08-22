import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { GraphNode } from '@graphcoder/core'
import { layoutGraph, type LayoutEdge, type LayoutNode, type LayoutResult } from '../layout/elk.js'
import { selectNode, state } from '../state/store.js'

// ── Colour helpers ────────────────────────────────────────────────────────────

const KIND_FILL: Record<string, string> = {
  function: '#1e40af',
  method: '#1e40af',
  class: '#581c87',
  struct: '#581c87',
  file: '#374151',
  interface: '#115e59',
  trait: '#115e59',
  protocol: '#115e59',
  component: '#1e3a5f'
}

function nodeFill(kind: string | undefined): string {
  return KIND_FILL[kind ?? ''] ?? '#1f2937'
}

const EDGE_STROKE: Record<string, string> = {
  calls: '#3b82f6',
  imports: '#9ca3af',
  extends: '#a78bfa',
  implements: '#a78bfa'
}

function edgeStroke(kind: string | undefined): string {
  return EDGE_STROKE[kind ?? ''] ?? '#4b5563'
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface NodeRectProps {
  layoutNode: LayoutNode
  graphNode: GraphNode | undefined
  selected: boolean
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
      <rect
        width={props.layoutNode.width}
        height={props.layoutNode.height}
        fill={nodeFill(props.graphNode?.kind)}
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
      stroke={edgeStroke(props.edge.kind)}
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
  const [viewBox, setViewBox] = createSignal({ x: 0, y: 0, w: 800, h: 600 })

  let svgRef: SVGSVGElement | undefined

  // Recompute layout when nodes / edges / viewMode change
  createEffect(async () => {
    const nodes = state.nodes
    const edges = state.edges
    const viewMode = state.viewMode
    if (nodes.length === 0) return
    setIsLayouting(true)
    try {
      const result = await layoutGraph(nodes, edges, viewMode)
      setLayout(result)
      setViewBox({ x: -20, y: -20, w: result.width + 40, h: result.height + 40 })
    } finally {
      setIsLayouting(false)
    }
  })

  // ── Pan / zoom ──────────────────────────────────────────────────────────────

  let isPanning = false
  let panStart = { clientX: 0, clientY: 0 }
  let vbAtPanStart = { x: 0, y: 0, w: 800, h: 600 }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    isPanning = true
    panStart = { clientX: e.clientX, clientY: e.clientY }
    vbAtPanStart = { ...viewBox() }
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (!isPanning || !svgRef) return
    const vb = vbAtPanStart
    const rect = svgRef.getBoundingClientRect()
    const dx = (e.clientX - panStart.clientX) * (vb.w / rect.width)
    const dy = (e.clientY - panStart.clientY) * (vb.h / rect.height)
    setViewBox({ x: vb.x - dx, y: vb.y - dy, w: vb.w, h: vb.h })
  }

  const handleMouseUp = () => {
    isPanning = false
  }

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (!svgRef) return
    const vb = viewBox()
    const rect = svgRef.getBoundingClientRect()
    const mouseXRatio = (e.clientX - rect.left) / rect.width
    const mouseYRatio = (e.clientY - rect.top) / rect.height
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
    const newW = vb.w * factor
    const newH = vb.h * factor
    setViewBox({
      x: vb.x + mouseXRatio * (vb.w - newW),
      y: vb.y + mouseYRatio * (vb.h - newH),
      w: newW,
      h: newH
    })
  }

  onMount(() => {
    if (!svgRef) return
    svgRef.addEventListener('wheel', handleWheel, { passive: false })
    onCleanup(() => svgRef?.removeEventListener('wheel', handleWheel))
  })

  return (
    <div class="relative w-full h-full bg-gray-950 overflow-hidden" data-testid="graph-canvas">
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
      <svg
        ref={svgRef}
        class="w-full h-full"
        viewBox={`${viewBox().x} ${viewBox().y} ${viewBox().w} ${viewBox().h}`}
        data-testid="graph-svg"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#4b5563" />
          </marker>
        </defs>
        <g data-testid="graph-edges">
          <For each={layout()?.edges ?? []}>{(edge) => <EdgeLine edge={edge} />}</For>
        </g>
        <g data-testid="graph-nodes">
          <For each={layout() ? [...layout()!.nodes.values()] : []}>
            {(node) => {
              const graphNode = state.nodes.find((n) => n.id === node.id)
              return (
                <NodeRect
                  layoutNode={node}
                  graphNode={graphNode}
                  selected={state.selectedNodeId === node.id}
                  onClick={() => void selectNode(node.id)}
                />
              )
            }}
          </For>
        </g>
      </svg>
    </div>
  )
}
