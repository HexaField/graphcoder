import { type Component, createMemo, For, Show } from 'solid-js'
import type { Annotation } from '@graphcoder/core'
import type { LayoutNode } from '../layout/elk.js'
import { state, selectAnnotation } from '../state/store.js'

export interface AnnotationOverlayProps {
  panX: number
  panY: number
  zoom: number
  layoutNodes: Map<string, LayoutNode> | null
  semanticToLayoutId: Map<string, string>
}

const KIND_COLORS: Record<string, string> = {
  boundary: '#3b82f6',
  path: '#f59e0b',
  note: '#10b981',
  question: '#ef4444',
  projection: '#8b5cf6'
}

const KIND_LABELS: Record<string, string> = {
  boundary: 'B',
  path: 'P',
  note: 'N',
  question: '?',
  projection: 'S'
}

const AI_BADGE_COLOR = '#9333ea'

function isProposed(ann: Annotation): boolean {
  return ann.status === 'proposed'
}

function memberPositions(
  members: string[],
  semanticToLayoutId: Map<string, string>,
  layoutNodes: Map<string, LayoutNode>
): LayoutNode[] {
  const result: LayoutNode[] = []
  for (const semId of members) {
    const layoutId = semanticToLayoutId.get(semId)
    if (!layoutId) continue
    const node = layoutNodes.get(layoutId)
    if (node) result.push(node)
  }
  return result
}

function boundingRect(nodes: LayoutNode[], pad: number): { x: number; y: number; w: number; h: number } | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x + n.width > maxX) maxX = n.x + n.width
    if (n.y + n.height > maxY) maxY = n.y + n.height
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

const BoundaryOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
}> = (props) => {
  const positions = createMemo(() =>
    memberPositions(props.annotation.members, props.semanticToLayoutId, props.layoutNodes)
  )
  const rect = createMemo(() => boundingRect(positions(), 16))
  const color = () => KIND_COLORS[props.annotation.kind]
  const proposed = () => isProposed(props.annotation)

  return (
    <Show when={rect()}>
      {(r) => (
        <g opacity={proposed() ? '0.7' : '1'}>
          <rect
            x={r().x}
            y={r().y}
            width={r().w}
            height={r().h}
            fill={color()}
            fill-opacity="0.06"
            stroke={color()}
            stroke-width="2"
            stroke-dasharray={proposed() ? '3 3' : '6 3'}
            rx={8}
            ry={8}
          />
          <text x={r().x + 6} y={r().y - 4} fill={color()} font-size="12" font-weight="600">
            {props.annotation.label}
          </text>
          <Show when={proposed()}>
            <text
              x={r().x + 6 + props.annotation.label.length * 7 + 8}
              y={r().y - 4}
              fill={AI_BADGE_COLOR}
              font-size="9"
              font-weight="700"
              opacity="0.8"
            >
              AI
            </text>
          </Show>
        </g>
      )}
    </Show>
  )
}

const PathOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
}> = (props) => {
  const stepCenters = createMemo(() => {
    if (!props.annotation.steps) return []
    return props.annotation.steps
      .map((step) => {
        if (!step.architectureNodeId) return null
        const layoutId = props.semanticToLayoutId.get(step.architectureNodeId)
        if (!layoutId) return null
        const node = props.layoutNodes.get(layoutId)
        if (!node) return null
        return { cx: node.x + node.width / 2, cy: node.y + node.height / 2, label: step.label }
      })
      .filter((v): v is { cx: number; cy: number; label: string } => v !== null)
  })

  const color = () => KIND_COLORS.path
  const proposed = () => isProposed(props.annotation)

  return (
    <Show when={stepCenters().length >= 2}>
      <g opacity={proposed() ? '0.7' : '1'}>
        <For each={stepCenters().slice(0, -1)}>
          {(pt, idx) => {
            const next = () => stepCenters()[idx() + 1]
            return (
              <Show when={next()}>
                {(n) => (
                  <line
                    x1={pt.cx}
                    y1={pt.cy}
                    x2={n().cx}
                    y2={n().cy}
                    stroke={color()}
                    stroke-width="2.5"
                    stroke-opacity="0.7"
                    stroke-dasharray={proposed() ? '4 4' : 'none'}
                    marker-end="url(#annotation-arrow)"
                  />
                )}
              </Show>
            )
          }}
        </For>
        <For each={stepCenters()}>
          {(pt) => (
            <g>
              <circle cx={pt.cx} cy={pt.cy} r={6} fill={color()} fill-opacity="0.9" />
              <text x={pt.cx + 10} y={pt.cy + 4} fill={color()} font-size="11" font-weight="500">
                {pt.label}
              </text>
            </g>
          )}
        </For>
        <Show when={proposed()}>
          {(() => {
            const first = stepCenters()[0]
            if (!first) return null
            return (
              <text
                x={first.cx + 10}
                y={first.cy - 12}
                fill={AI_BADGE_COLOR}
                font-size="9"
                font-weight="700"
                opacity="0.8"
              >
                AI
              </text>
            )
          })()}
        </Show>
      </g>
    </Show>
  )
}

const MarkerOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
}> = (props) => {
  const position = createMemo(() => {
    if (props.annotation.members.length === 0) {
      return { cx: props.annotation.anchor.x, cy: props.annotation.anchor.y }
    }
    const positions = memberPositions(props.annotation.members, props.semanticToLayoutId, props.layoutNodes)
    if (positions.length === 0) return null
    const first = positions[0]
    return { cx: first.x + first.width + 12, cy: first.y }
  })

  const color = () => KIND_COLORS[props.annotation.kind]
  const label = () => KIND_LABELS[props.annotation.kind]
  const proposed = () => isProposed(props.annotation)

  return (
    <Show when={position()}>
      {(pos) => (
        <g
          style={{ cursor: 'pointer' }}
          opacity={proposed() ? '0.7' : '1'}
          onClick={() => selectAnnotation(props.annotation.id)}
        >
          <circle
            cx={pos().cx}
            cy={pos().cy}
            r={10}
            fill={color()}
            fill-opacity="0.85"
            stroke={proposed() ? AI_BADGE_COLOR : 'none'}
            stroke-width={proposed() ? '1.5' : '0'}
            stroke-dasharray={proposed() ? '2 2' : 'none'}
          />
          <text x={pos().cx} y={pos().cy + 4} text-anchor="middle" fill="white" font-size="11" font-weight="700">
            {label()}
          </text>
          <text x={pos().cx + 16} y={pos().cy + 4} fill={color()} font-size="11" font-weight="500">
            {props.annotation.label}
          </text>
          <Show when={proposed()}>
            <text
              x={pos().cx + 16 + props.annotation.label.length * 6 + 6}
              y={pos().cy + 4}
              fill={AI_BADGE_COLOR}
              font-size="9"
              font-weight="700"
              opacity="0.8"
            >
              AI
            </text>
          </Show>
        </g>
      )}
    </Show>
  )
}

export const AnnotationOverlay: Component<AnnotationOverlayProps> = (props) => {
  const activeAnnotations = createMemo(() =>
    state.annotations.filter((a) => a.status !== 'dismissed' && a.status !== 'applied')
  )

  return (
    <svg class="absolute inset-0 w-full h-full pointer-events-none" style={{ 'z-index': 20 }}>
      <defs>
        <marker
          id="annotation-arrow"
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={KIND_COLORS.path} />
        </marker>
      </defs>
      <Show when={props.layoutNodes}>
        {(nodes) => (
          <g transform={`translate(${props.panX}, ${props.panY}) scale(${props.zoom})`}>
            <For each={activeAnnotations()}>
              {(ann) => {
                switch (ann.kind) {
                  case 'boundary':
                    return (
                      <BoundaryOverlay
                        annotation={ann}
                        layoutNodes={nodes()}
                        semanticToLayoutId={props.semanticToLayoutId}
                      />
                    )
                  case 'path':
                    return (
                      <PathOverlay
                        annotation={ann}
                        layoutNodes={nodes()}
                        semanticToLayoutId={props.semanticToLayoutId}
                      />
                    )
                  default:
                    return (
                      <g style={{ 'pointer-events': 'all' }}>
                        <MarkerOverlay
                          annotation={ann}
                          layoutNodes={nodes()}
                          semanticToLayoutId={props.semanticToLayoutId}
                        />
                      </g>
                    )
                }
              }}
            </For>
          </g>
        )}
      </Show>
    </svg>
  )
}
