/**
 * Annotation overlay.
 *
 * Rendering follows SHAPE; colour follows KIND. There is no per-kind render
 * branch — a user-invented kind draws exactly like any other kind of the
 * same shape, just in its own colour.
 */
import { type Component, createMemo, For, Show } from 'solid-js'
import type { Annotation, Point } from '@graphcoder/core'
import type { LayoutNode } from '../layout/elk.js'
import { state, selectAnnotation, kindColor } from '../state/store.js'

export interface AnnotationOverlayProps {
  panX: number
  panY: number
  zoom: number
  layoutNodes: Map<string, LayoutNode> | null
  semanticToLayoutId: Map<string, string>
}

/** Colour used to mark an AI proposal, regardless of kind */
const AI_BADGE_COLOR = '#9333ea'
/** Colour used when an annotation's members no longer resolve */
const STALE_COLOR = '#ef4444'

function isProposed(ann: Annotation): boolean {
  return ann.status === 'proposed'
}

function isStale(ann: Annotation): boolean {
  return ann.status === 'stale'
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

/** Stroke colour: stale overrides kind colour, since staleness is urgent. */
function strokeColor(ann: Annotation): string {
  return isStale(ann) ? STALE_COLOR : kindColor(ann.kind)
}

/** Dash pattern encodes status, not kind. */
function dashArray(ann: Annotation): string | undefined {
  if (isProposed(ann)) return '5 4'
  if (isStale(ann)) return '2 3'
  return undefined
}

// ── Shape renderers ──────────────────────────────────────────────────────────

const RegionOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
  onSelect: () => void
}> = (props) => {
  const drawn = createMemo(() => props.annotation.geometry?.points ?? [])

  /** Fall back to a bounding box when the outline was not preserved. */
  const fallbackRect = createMemo(() => {
    if (drawn().length >= 3) return null
    const positions = memberPositions(props.annotation.members ?? [], props.semanticToLayoutId, props.layoutNodes)
    return boundingRect(positions, 16)
  })

  const color = () => strokeColor(props.annotation)

  const labelPos = createMemo(() => {
    const r = fallbackRect()
    if (r) return { x: r.x + 6, y: r.y - 6 }
    const pts = drawn()
    if (pts.length === 0) return { x: 0, y: 0 }
    let minX = Infinity
    let minY = Infinity
    for (const [x, y] of pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
    }
    return { x: minX + 4, y: minY - 6 }
  })

  return (
    <Show when={drawn().length >= 3 || fallbackRect()}>
      <g
        opacity={isProposed(props.annotation) ? '0.75' : '1'}
        style={{ 'pointer-events': 'all', cursor: 'pointer' }}
        onClick={props.onSelect}
      >
        <Show
          when={drawn().length >= 3}
          fallback={
            <Show when={fallbackRect()}>
              {(r) => (
                <rect
                  x={r().x}
                  y={r().y}
                  width={r().w}
                  height={r().h}
                  fill={color()}
                  fill-opacity="0.06"
                  stroke={color()}
                  stroke-width="2"
                  stroke-dasharray={dashArray(props.annotation)}
                  rx={8}
                  ry={8}
                />
              )}
            </Show>
          }
        >
          <polygon
            points={drawn()
              .map(([x, y]) => `${x},${y}`)
              .join(' ')}
            fill={color()}
            fill-opacity="0.07"
            stroke={color()}
            stroke-width="2"
            stroke-dasharray={dashArray(props.annotation)}
            stroke-linejoin="round"
          />
        </Show>
        <AnnotationLabel annotation={props.annotation} x={labelPos().x} y={labelPos().y} color={color()} />
      </g>
    </Show>
  )
}

const PolylineOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
  onSelect: () => void
}> = (props) => {
  /**
   * Prefer live node centres so the path tracks relayout. Fall back to the
   * drawn stroke when members no longer resolve to visible nodes.
   */
  const centres = createMemo(() => {
    const positions = memberPositions(props.annotation.members ?? [], props.semanticToLayoutId, props.layoutNodes)
    if (positions.length >= 2) {
      return positions.map((n) => [n.x + n.width / 2, n.y + n.height / 2] as Point)
    }
    return props.annotation.geometry?.points ?? []
  })

  const color = () => strokeColor(props.annotation)

  return (
    <Show when={centres().length >= 2}>
      <g
        opacity={isProposed(props.annotation) ? '0.75' : '1'}
        style={{ 'pointer-events': 'all', cursor: 'pointer' }}
        onClick={props.onSelect}
      >
        <polyline
          points={centres()
            .map(([x, y]) => `${x},${y}`)
            .join(' ')}
          fill="none"
          stroke={color()}
          stroke-width="2.5"
          stroke-opacity="0.8"
          stroke-dasharray={dashArray(props.annotation)}
          stroke-linejoin="round"
          stroke-linecap="round"
          marker-end="url(#annotation-arrow)"
        />
        <For each={centres()}>{([x, y]) => <circle cx={x} cy={y} r={5} fill={color()} fill-opacity="0.9" />}</For>
        <AnnotationLabel
          annotation={props.annotation}
          x={(centres()[0]?.[0] ?? 0) + 10}
          y={(centres()[0]?.[1] ?? 0) - 10}
          color={color()}
        />
      </g>
    </Show>
  )
}

const PointOverlay: Component<{
  annotation: Annotation
  layoutNodes: Map<string, LayoutNode>
  semanticToLayoutId: Map<string, string>
  onSelect: () => void
}> = (props) => {
  const position = createMemo(() => {
    // Anchor to a member node when one resolves, so the pin follows relayout
    const positions = memberPositions(props.annotation.members ?? [], props.semanticToLayoutId, props.layoutNodes)
    const first = positions[0]
    if (first) return { cx: first.x + first.width + 12, cy: first.y }
    const anchor = props.annotation.geometry?.anchor
    return { cx: anchor?.x ?? 0, cy: anchor?.y ?? 0 }
  })

  const color = () => strokeColor(props.annotation)

  return (
    <g style={{ 'pointer-events': 'all', cursor: 'pointer' }} onClick={props.onSelect}>
      <circle
        cx={position().cx}
        cy={position().cy}
        r={7}
        fill={color()}
        fill-opacity={isProposed(props.annotation) ? '0.55' : '0.9'}
        stroke={isProposed(props.annotation) ? AI_BADGE_COLOR : 'none'}
        stroke-width={isProposed(props.annotation) ? '1.5' : '0'}
        stroke-dasharray={isProposed(props.annotation) ? '2 2' : undefined}
      />
      <AnnotationLabel annotation={props.annotation} x={position().cx + 12} y={position().cy + 4} color={color()} />
    </g>
  )
}

/** Kind chip + label, shared by every shape. */
const AnnotationLabel: Component<{
  annotation: Annotation
  x: number
  y: number
  color: string
}> = (props) => {
  const text = () => {
    const { kind, label } = props.annotation
    if (kind && label && label.toLowerCase() !== kind.toLowerCase()) return `${kind} · ${label}`
    return label || kind || 'untitled'
  }

  return (
    <>
      <text x={props.x} y={props.y} fill={props.color} font-size="11" font-weight="600">
        {text()}
      </text>
      <Show when={isProposed(props.annotation)}>
        <text
          x={props.x + text().length * 6 + 8}
          y={props.y}
          fill={AI_BADGE_COLOR}
          font-size="9"
          font-weight="700"
          opacity="0.85"
        >
          AI
        </text>
      </Show>
    </>
  )
}

// ── Overlay root ─────────────────────────────────────────────────────────────

export const AnnotationOverlay: Component<AnnotationOverlayProps> = (props) => {
  const visibleAnnotations = createMemo(() =>
    state.annotations.filter((a) => {
      if (a.status === 'dismissed') return false
      // Kind visibility toggles come from the outline panel
      if (a.kind && state.hiddenKinds.includes(a.kind)) return false
      return true
    })
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
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <Show when={props.layoutNodes}>
        {(nodes) => (
          <g transform={`translate(${props.panX}, ${props.panY}) scale(${props.zoom})`}>
            <For each={visibleAnnotations()}>
              {(ann) => {
                const select = () => selectAnnotation(ann.id)
                switch (ann.shape) {
                  case 'region':
                    return (
                      <RegionOverlay
                        annotation={ann}
                        layoutNodes={nodes()}
                        semanticToLayoutId={props.semanticToLayoutId}
                        onSelect={select}
                      />
                    )
                  case 'polyline':
                    return (
                      <PolylineOverlay
                        annotation={ann}
                        layoutNodes={nodes()}
                        semanticToLayoutId={props.semanticToLayoutId}
                        onSelect={select}
                      />
                    )
                  default:
                    return (
                      <PointOverlay
                        annotation={ann}
                        layoutNodes={nodes()}
                        semanticToLayoutId={props.semanticToLayoutId}
                        onSelect={select}
                      />
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
