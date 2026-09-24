import { type Component, For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { flowSuccessors, sliceBodyFlow, type BodyFlow, type CFNode } from '@graphcoder/core'
import {
  BF_BLOCK_PAD_Y,
  BF_ROW_H,
  layoutBodyFlow,
  type BFLayoutEdge,
  type BFLayoutNode,
  type BFLayoutResult,
  type LayoutNode
} from '../layout/elk.js'
import { selectNode, state } from '../state/store.js'
import { collapseBodyFlow } from '../state/body-flow.js'

const KIND_FILL: Record<string, string> = {
  entry: '#1d4ed8',
  exit: '#6b7280',
  call: '#f8fafc',
  block: '#f8fafc',
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
  block: '#94a3b8',
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
  block: '#1e293b',
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

/** Flow-view path slice: on-path strokes, and the opacity for everything off it */
const PATH_STROKE = '#f59e0b'
const PATH_TEXT = '#b45309'
const OFF_PATH_OPACITY = 0.25

/** `onPath`: null when no slice applies, otherwise whether the element lies on the traced path */
type PathState = boolean | null

function fit(text: string, width: number): string {
  const max = Math.floor((width - 12) / 6)
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

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

const OUTLINES: Record<string, (x: number, y: number, w: number, h: number) => string> = {
  branch: diamondPath,
  loop: hexagonPath,
  guard: octagonPath
}

function tooltip(n: CFNode): string {
  if (n.calls) return n.calls.map((c) => `${c.label}${c.targetNodeId ? ' → click to select' : ''}`).join('\n')
  if (n.kind === 'branch') return n.condition || n.label
  return n.targetNodeId ? `${n.label} → click to select` : n.label
}

function NodeShape(props: {
  node: CFNode
  layout: BFLayoutNode
  onPath: PathState
  targets: ReadonlySet<string> | null
  onClickTarget: (id: string) => void
}) {
  const n = () => props.node
  const l = () => props.layout
  const fill = () => KIND_FILL[n().kind] ?? '#f8fafc'
  const stroke = () => (props.onPath ? PATH_STROKE : (KIND_STROKE[n().kind] ?? '#94a3b8'))
  const strokeWidth = () => (props.onPath ? 2.5 : 1.5)
  const textColor = () => KIND_TEXT[n().kind] ?? '#1e293b'
  const hasTarget = () => n().targetNodeId != null

  const select = (e: MouseEvent, id: string | null | undefined) => {
    e.stopPropagation()
    if (id) props.onClickTarget(id)
  }

  const pill = () => n().kind === 'entry' || n().kind === 'exit'

  return (
    <g
      data-testid="cf-node"
      data-kind={n().kind}
      data-target={n().targetNodeId ?? undefined}
      data-on-path={props.onPath === null ? undefined : String(props.onPath)}
      opacity={props.onPath === false ? OFF_PATH_OPACITY : 1}
      class={hasTarget() ? 'cursor-pointer' : ''}
      onClick={(e) => select(e, n().targetNodeId)}
    >
      <title>{tooltip(n())}</title>
      <Show
        when={OUTLINES[n().kind]}
        fallback={
          <rect
            x={l().x}
            y={l().y}
            width={l().width}
            height={l().height}
            rx={pill() ? l().height / 2 : 4}
            fill={fill()}
            stroke={stroke()}
            stroke-width={strokeWidth()}
            stroke-dasharray={n().kind === 'await' ? '4 2' : undefined}
          />
        }
      >
        {(outline) => (
          <path
            d={outline()(l().x, l().y, l().width, l().height)}
            fill={fill()}
            stroke={stroke()}
            stroke-width={strokeWidth()}
          />
        )}
      </Show>
      <Show
        when={n().calls}
        fallback={
          <text
            x={l().x + l().width / 2}
            y={l().y + l().height / 2}
            text-anchor="middle"
            dominant-baseline="central"
            fill={textColor()}
            font-size="10"
            font-family="ui-monospace, monospace"
          >
            {fit(n().label, l().width)}
          </text>
        }
      >
        {(calls) => (
          <For each={calls()}>
            {(call, i) => {
              const hit = () => call.targetNodeId != null && props.targets?.has(call.targetNodeId) === true
              return (
                <text
                  data-testid="cf-block-row"
                  data-target={call.targetNodeId ?? undefined}
                  data-hit={hit() ? 'true' : undefined}
                  x={l().x + 8}
                  y={l().y + BF_BLOCK_PAD_Y + i() * BF_ROW_H + BF_ROW_H / 2}
                  dominant-baseline="central"
                  fill={hit() ? PATH_TEXT : call.await ? KIND_TEXT['await'] : textColor()}
                  font-weight={hit() ? 'bold' : undefined}
                  font-size="10"
                  font-family="ui-monospace, monospace"
                  class={call.targetNodeId ? 'cursor-pointer' : ''}
                  onClick={(e) => select(e, call.targetNodeId)}
                >
                  {fit(`${call.label}${call.targetNodeId ? ' ↗' : ''}`, l().width - 4)}
                </text>
              )
            }}
          </For>
        )}
      </Show>
      <Show when={hasTarget()}>
        <path
          d={`M${l().x + l().width - 8},${l().y + 4} H${l().x + l().width - 4} M${l().x + l().width - 6},${l().y + 2} L${l().x + l().width - 4},${l().y + 4} L${l().x + l().width - 6},${l().y + 6}`}
          fill="none"
          stroke={stroke()}
          stroke-width="1"
        />
      </Show>
    </g>
  )
}

function EdgeLine(props: { edge: BFLayoutEdge; onPath: PathState }) {
  const e = () => props.edge
  const color = () => (props.onPath ? PATH_STROKE : (EDGE_COLORS[e().kind] ?? '#94a3b8'))
  const label = () => EDGE_LABELS[e().kind]

  const pathD = () => {
    const pts = e().points
    if (pts.length < 2) return ''
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  }

  const midpoint = () => e().points[Math.floor(e().points.length / 2)] ?? { x: 0, y: 0 }

  const arrowAngle = () => {
    const pts = e().points
    if (pts.length < 2) return 0
    const last = pts[pts.length - 1]!
    const prev = pts[pts.length - 2]!
    return (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI
  }

  const arrowTip = () => e().points[e().points.length - 1] ?? { x: 0, y: 0 }

  return (
    <g
      data-testid="cf-edge"
      data-on-path={props.onPath === null ? undefined : String(props.onPath)}
      opacity={props.onPath === false ? OFF_PATH_OPACITY : 1}
    >
      <path
        d={pathD()}
        fill="none"
        stroke={color()}
        stroke-width={props.onPath ? 2.5 : 1.5}
        stroke-dasharray={e().kind === 'loop_back' ? '4 3' : undefined}
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
const MIN_VISIBLE_H = 240

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
    setLayout(await layoutBodyFlow(bf.nodes, bf.edges))
  })

  // Flow view: highlight the path from entry to the calls that lead to the next function in any traced flow
  const targets = createMemo(() => (state.viewMode === 'flow' ? flowSuccessors(state.tracedFlows, props.nodeId) : null))
  const slice = createMemo(() => {
    const t = targets()
    return t && t.size > 0 ? sliceBodyFlow(props.bodyFlow, t) : null
  })
  const nodeOnPath = (id: string): PathState => slice()?.nodeIds.has(id) ?? null
  const edgeOnPath = (index: number): PathState => slice()?.edgeIndices.has(index) ?? null

  const pathTargets = createMemo(() => {
    const s = slice()
    const t = targets()
    if (!s || !t) return ''
    const hitIds = new Set<string>()
    for (const n of props.bodyFlow.nodes) {
      if (!s.hitNodeIds.has(n.id)) continue
      for (const id of [n.targetNodeId, ...(n.calls ?? []).map((c) => c.targetNodeId)]) {
        if (id && t.has(id)) hitIds.add(id)
      }
    }
    const names = new Map<string, string>()
    for (const flow of state.tracedFlows) for (const n of flow.nodes) if (hitIds.has(n.id)) names.set(n.id, n.name)
    return [...names.values()].join(', ')
  })

  const cardW = () => (layout()?.width ?? 200) + PAD * 2
  const cardWidth = () => `min(${cardW()}px, calc(100% - 16px))`
  /** Below the anchor node, but always leaving room to show a useful part of the card */
  const cardTop = () => `max(8px, min(${props.screenY}px, calc(100% - ${MIN_VISIBLE_H}px)))`

  return (
    <Show when={layout()}>
      {(l) => (
        <div
          data-testid="body-flow-card"
          class="absolute rounded-lg border border-slate-700 shadow-xl overflow-auto"
          style={{
            // Percentages resolve against the canvas area, so the card never slides under side or bottom panels
            left: `max(8px, min(${props.screenX}px, calc(100% - ${cardWidth()} - 8px)))`,
            top: cardTop(),
            width: cardWidth(),
            background: 'rgba(15, 23, 42, 0.97)',
            'z-index': '30',
            'pointer-events': 'all',
            'max-height': `calc(100% - ${cardTop()} - 8px)`
          }}
        >
          <div
            class="sticky top-0 z-10 flex items-center justify-between px-3 border-b border-slate-700"
            style={{ 'min-height': `${HEADER_H}px`, background: 'rgb(15, 23, 42)' }}
          >
            <div class="min-w-0 py-1">
              <div class="text-xs font-mono text-slate-400 truncate" title={props.bodyFlow.signature}>
                {props.bodyFlow.signature}
              </div>
              <Show when={pathTargets()}>
                <div data-testid="body-flow-path" class="text-[10px] font-mono truncate" style={{ color: PATH_STROKE }}>
                  path → {pathTargets()}
                </div>
              </Show>
            </div>
            <button
              class="text-slate-500 hover:text-slate-300 text-xs ml-2 flex-shrink-0"
              onClick={() => collapseBodyFlow(props.nodeId)}
              title="Close body flow"
            >
              ✕
            </button>
          </div>
          <svg width={cardW()} height={(layout()?.height ?? 100) + PAD} class="block">
            <g transform={`translate(${PAD}, ${PAD / 2})`}>
              <For each={l().edges}>{(edge) => <EdgeLine edge={edge} onPath={edgeOnPath(edge.index)} />}</For>
              <For each={props.bodyFlow.nodes}>
                {(node) => (
                  <Show when={l().nodes.get(node.id)}>
                    {(nl) => (
                      <NodeShape
                        node={node}
                        layout={nl()}
                        onPath={nodeOnPath(node.id)}
                        targets={slice() ? targets() : null}
                        onClickTarget={props.onClickTarget}
                      />
                    )}
                  </Show>
                )}
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
}> = (props) => {
  const resolveAnchor = (nodeId: string): LayoutNode | undefined => {
    const layoutId = props.semanticToLayoutId.get(nodeId)
    return (layoutId ? props.layoutNodes?.get(layoutId) : undefined) ?? props.layoutNodes?.get(nodeId)
  }

  const screenPos = (nodeId: string) => {
    const anchor = resolveAnchor(nodeId)
    if (!anchor) return { x: 300, y: 80 }
    const x = (anchor.x + anchor.width / 2) * props.zoom + props.panX
    const y = (anchor.y + anchor.height) * props.zoom + props.panY
    return { x: Math.max(8, x - 150), y: y + 8 }
  }

  return (
    <Show when={state.expandedBodyFlows.size > 0}>
      <div class="absolute inset-0 pointer-events-none" style={{ 'z-index': '25' }}>
        <For each={[...state.expandedBodyFlows]}>
          {(nodeId) => (
            <Show when={state.bodyFlowData.get(nodeId)}>
              {(bf) => (
                <BodyFlowCard
                  nodeId={nodeId}
                  bodyFlow={bf()}
                  screenX={screenPos(nodeId).x}
                  screenY={screenPos(nodeId).y}
                  onClickTarget={(id) => void selectNode(id)}
                />
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
