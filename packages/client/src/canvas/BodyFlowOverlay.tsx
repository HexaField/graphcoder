import { type Component, For, Show, createEffect, createSignal } from 'solid-js'
import type { BodyFlow, CFNode } from '@graphcoder/core'
import { layoutBodyFlow, type BFLayoutNode, type BFLayoutResult } from '../layout/elk.js'
import type { LayoutNode } from '../layout/elk.js'
import { selectNode, state } from '../state/store.js'
import { collapseBodyFlow } from '../state/body-flow.js'

const KIND_FILL: Record<string, string> = {
  entry: '#1d4ed8',
  exit: '#6b7280',
  call: '#f8fafc',
  branch: '#fef3c7',
  loop: '#dbeafe',
  try: '#e0e7ff',
  catch: '#fee2e2',
  finally: '#ede9fe',
  guard: '#fce7f3',
  await: '#ecfdf5'
}

const KIND_STROKE: Record<string, string> = {
  entry: '#1e40af',
  exit: '#4b5563',
  call: '#94a3b8',
  branch: '#d97706',
  loop: '#3b82f6',
  try: '#6366f1',
  catch: '#ef4444',
  finally: '#8b5cf6',
  guard: '#ec4899',
  await: '#10b981'
}

const KIND_TEXT: Record<string, string> = {
  entry: '#ffffff',
  exit: '#ffffff',
  call: '#1e293b',
  branch: '#92400e',
  loop: '#1e40af',
  try: '#3730a3',
  catch: '#991b1b',
  finally: '#5b21b6',
  guard: '#9d174d',
  await: '#065f46'
}

const EDGE_COLORS: Record<string, string> = {
  next: '#94a3b8',
  true: '#22c55e',
  false: '#ef4444',
  loop_body: '#3b82f6',
  loop_back: '#3b82f6',
  loop_exit: '#94a3b8',
  try_body: '#6366f1',
  catch_entry: '#ef4444',
  finally_entry: '#8b5cf6'
}

const EDGE_LABELS: Record<string, string> = { true: 'Y', false: 'N' }

function diamondPath(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2,
    cy = y + h / 2
  return `M${cx},${y} L${x + w},${cy} L${cx},${y + h} L${x},${cy} Z`
}

function hexagonPath(x: number, y: number, w: number, h: number): string {
  const inset = Math.min(10, w * 0.15)
  return `M${x + inset},${y} L${x + w - inset},${y} L${x + w},${y + h / 2} L${x + w - inset},${y + h} L${x + inset},${y + h} L${x},${y + h / 2} Z`
}

function octagonPath(x: number, y: number, w: number, h: number): string {
  const c = Math.min(8, Math.min(w, h) * 0.25)
  return `M${x + c},${y} L${x + w - c},${y} L${x + w},${y + c} L${x + w},${y + h - c} L${x + w - c},${y + h} L${x + c},${y + h} L${x},${y + h - c} L${x},${y + c} Z`
}

function NodeShape(props: { node: CFNode; layout: BFLayoutNode; onClickTarget?: (id: string) => void }) {
  const n = () => props.node
  const l = () => props.layout
  const fill = () => KIND_FILL[n().kind] ?? '#f8fafc'
  const stroke = () => KIND_STROKE[n().kind] ?? '#94a3b8'
  const textColor = () => KIND_TEXT[n().kind] ?? '#1e293b'
  const cx = () => l().x + l().width / 2
  const cy = () => l().y + l().height / 2
  const hasTarget = () => n().targetNodeId != null

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (hasTarget()) props.onClickTarget?.(n().targetNodeId!)
  }

  const labelText = () => {
    const text = n().label
    const maxLen = Math.floor((l().width - 12) / 6)
    return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text
  }

  return (
    <g class={hasTarget() ? 'cursor-pointer' : ''} onClick={handleClick}>
      {n().kind === 'branch' ? (
        <path d={diamondPath(l().x, l().y, l().width, l().height)} fill={fill()} stroke={stroke()} stroke-width="1.5" />
      ) : n().kind === 'loop' ? (
        <path d={hexagonPath(l().x, l().y, l().width, l().height)} fill={fill()} stroke={stroke()} stroke-width="1.5" />
      ) : n().kind === 'guard' ? (
        <path d={octagonPath(l().x, l().y, l().width, l().height)} fill={fill()} stroke={stroke()} stroke-width="1.5" />
      ) : n().kind === 'entry' || n().kind === 'exit' ? (
        <rect
          x={l().x}
          y={l().y}
          width={l().width}
          height={l().height}
          rx={l().height / 2}
          fill={fill()}
          stroke={stroke()}
          stroke-width="1.5"
        />
      ) : n().kind === 'await' ? (
        <rect
          x={l().x}
          y={l().y}
          width={l().width}
          height={l().height}
          rx="4"
          fill={fill()}
          stroke={stroke()}
          stroke-width="1.5"
          stroke-dasharray="4 2"
        />
      ) : (
        <rect
          x={l().x}
          y={l().y}
          width={l().width}
          height={l().height}
          rx="4"
          fill={fill()}
          stroke={stroke()}
          stroke-width="1.5"
        />
      )}
      <text
        x={cx()}
        y={cy()}
        text-anchor="middle"
        dominant-baseline="central"
        fill={textColor()}
        font-size="10"
        font-family="ui-monospace, monospace"
      >
        {labelText()}
      </text>
      <Show when={hasTarget()}>
        <line
          x1={l().x + l().width - 8}
          y1={l().y + 4}
          x2={l().x + l().width - 4}
          y2={l().y + 4}
          stroke={stroke()}
          stroke-width="1"
        />
        <line
          x1={l().x + l().width - 6}
          y1={l().y + 2}
          x2={l().x + l().width - 4}
          y2={l().y + 4}
          stroke={stroke()}
          stroke-width="1"
        />
        <line
          x1={l().x + l().width - 6}
          y1={l().y + 6}
          x2={l().x + l().width - 4}
          y2={l().y + 4}
          stroke={stroke()}
          stroke-width="1"
        />
      </Show>
    </g>
  )
}

function EdgeLine(props: {
  edge: { source: string; target: string; kind: string; points: Array<{ x: number; y: number }> }
}) {
  const e = () => props.edge
  const color = () => EDGE_COLORS[e().kind] ?? '#94a3b8'
  const dashed = () => e().kind === 'loop_back'
  const label = () => EDGE_LABELS[e().kind]

  const pathD = () => {
    const pts = e().points
    if (pts.length < 2) return ''
    let d = `M${pts[0]!.x},${pts[0]!.y}`
    for (let i = 1; i < pts.length; i++) d += ` L${pts[i]!.x},${pts[i]!.y}`
    return d
  }

  const midpoint = () => {
    const pts = e().points
    if (pts.length < 2) return { x: 0, y: 0 }
    return pts[Math.floor(pts.length / 2)]!
  }

  const arrowAngle = () => {
    const pts = e().points
    if (pts.length < 2) return 0
    const last = pts[pts.length - 1]!
    const prev = pts[pts.length - 2]!
    return (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI
  }

  const arrowTip = () => e().points[e().points.length - 1] ?? { x: 0, y: 0 }

  return (
    <g>
      <path
        d={pathD()}
        fill="none"
        stroke={color()}
        stroke-width="1.5"
        stroke-dasharray={dashed() ? '4 3' : undefined}
      />
      <polygon
        points="-6,-3 0,0 -6,3"
        fill={color()}
        transform={`translate(${arrowTip().x},${arrowTip().y}) rotate(${arrowAngle()})`}
      />
      <Show when={label()}>
        <text
          x={midpoint().x + 4}
          y={midpoint().y - 4}
          fill={color()}
          font-size="9"
          font-weight="bold"
          font-family="ui-monospace, monospace"
        >
          {label()}
        </text>
      </Show>
    </g>
  )
}

const PAD = 12
const HEADER_H = 28

function BodyFlowCard(props: {
  nodeId: string
  bodyFlow: BodyFlow
  screenX: number
  screenY: number
  onClickTarget: (id: string) => void
}) {
  const [layout, setLayout] = createSignal<BFLayoutResult | null>(null)

  createEffect(async () => {
    const bf = props.bodyFlow
    const result = await layoutBodyFlow(bf.nodes, bf.edges)
    setLayout(result)
  })

  const cardW = () => (layout()?.width ?? 200) + PAD * 2

  return (
    <Show when={layout()}>
      {(l) => (
        <div
          class="absolute rounded-lg border border-slate-700 shadow-xl overflow-auto"
          style={{
            left: `${Math.min(props.screenX, window.innerWidth - Math.min(cardW(), 500) - 20)}px`,
            top: `${props.screenY}px`,
            width: `${Math.min(cardW(), 500)}px`,
            background: 'rgba(15, 23, 42, 0.97)',
            'z-index': '30',
            'pointer-events': 'all',
            'max-height': '60vh'
          }}
        >
          <div
            class="flex items-center justify-between px-3 border-b border-slate-700"
            style={{ height: `${HEADER_H}px` }}
          >
            <span class="text-xs font-mono text-slate-400 truncate" style={{ 'max-width': '90%' }}>
              {props.bodyFlow.signature.slice(0, 80)}
            </span>
            <button
              class="text-slate-500 hover:text-slate-300 text-xs ml-2 flex-shrink-0"
              onClick={() => collapseBodyFlow(props.nodeId)}
            >
              ✕
            </button>
          </div>
          <svg width={cardW()} height={(layout()?.height ?? 100) + PAD} class="block">
            <g transform={`translate(${PAD}, ${PAD / 2})`}>
              <For each={l().edges}>{(edge) => <EdgeLine edge={edge} />}</For>
              <For each={props.bodyFlow.nodes}>
                {(node) => {
                  const nodeLayout = () => l().nodes.get(node.id)
                  return (
                    <Show when={nodeLayout()}>
                      {(nl) => <NodeShape node={node} layout={nl()} onClickTarget={props.onClickTarget} />}
                    </Show>
                  )
                }}
              </For>
            </g>
          </svg>
        </div>
      )}
    </Show>
  )
}

export const BodyFlowOverlay: Component<{
  panX: number
  panY: number
  zoom: number
  layoutNodes: Map<string, LayoutNode> | null
  semanticToLayoutId: Map<string, string>
  canvasOffset?: { x: number; y: number }
}> = (props) => {
  const expanded = () => state.expandedBodyFlows
  const data = () => state.bodyFlowData

  const handleClickTarget = (targetNodeId: string) => {
    void selectNode(targetNodeId)
  }

  const resolveAnchor = (nodeId: string): LayoutNode | undefined => {
    const layoutId = props.semanticToLayoutId.get(nodeId)
    if (layoutId) {
      const n = props.layoutNodes?.get(layoutId)
      if (n) return n
    }
    return props.layoutNodes?.get(nodeId)
  }

  const toScreen = (canvasX: number, canvasY: number) => ({
    x: canvasX * props.zoom + props.panX,
    y: canvasY * props.zoom + props.panY
  })

  return (
    <Show when={expanded().size > 0}>
      <div class="absolute inset-0 pointer-events-none" style={{ 'z-index': '25' }}>
        <For each={[...expanded()]}>
          {(nodeId) => {
            const bf = () => data().get(nodeId)
            const screenPos = () => {
              const anchor = resolveAnchor(nodeId)
              if (anchor) {
                const s = toScreen(anchor.x + anchor.width / 2, anchor.y + anchor.height)
                return { x: Math.max(8, s.x - 150), y: s.y + 8 }
              }
              return { x: 300, y: 80 }
            }
            return (
              <Show when={bf()}>
                <BodyFlowCard
                  nodeId={nodeId}
                  bodyFlow={bf()!}
                  screenX={screenPos().x}
                  screenY={screenPos().y}
                  onClickTarget={handleClickTarget}
                />
              </Show>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
