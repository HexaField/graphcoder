import { createSignal } from 'solid-js'
import type { AnnotationShape, Point } from '@graphcoder/core'

/**
 * Canvas interaction modes.
 *
 * There is exactly one annotation mode. The user does not choose a shape —
 * the drawing gesture decides it:
 *   drag on empty canvas  → freehand lasso  → region
 *   drag starting a node  → line through nodes → polyline
 *   click on empty canvas → point
 */
export type InteractionMode = 'select' | 'annotate'

const [mode, setModeSignal] = createSignal<InteractionMode>('select')

export const interactionMode = mode

export function setInteractionMode(m: InteractionMode): void {
  setModeSignal(m)
}

export function toggleInteractionMode(m: InteractionMode): void {
  setModeSignal((prev) => (prev === m ? 'select' : m))
}

/** A shape the user has drawn but not yet named and committed. */
export interface PendingDraw {
  shape: AnnotationShape
  /** Outline vertices (region) or waypoints (polyline), world coords */
  points: Point[]
  /** Label anchor / pin position, world coords */
  anchor: { x: number; y: number }
  /** Semantic IDs captured by the gesture; ordered for polyline */
  members: string[]
}

const [pendingDraw, setPendingDrawSignal] = createSignal<PendingDraw | null>(null)

export const pendingAnnotation = pendingDraw

export function setPendingAnnotation(draw: PendingDraw | null): void {
  setPendingDrawSignal(draw)
}

export function clearPendingAnnotation(): void {
  setPendingDrawSignal(null)
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Ray-casting point-in-polygon test.
 * Used to decide which node centres a lasso captured.
 */
export function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!
    const [xj, yj] = polygon[j]!
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Drop points closer together than `minDist` so a freehand stroke stores a
 * compact outline rather than every mouse sample.
 */
export function simplifyStroke(points: Point[], minDist = 6): Point[] {
  if (points.length <= 2) return points
  const out: Point[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const [px, py] = out[out.length - 1]!
    const [cx, cy] = points[i]!
    if (Math.hypot(cx - px, cy - py) >= minDist) out.push(points[i]!)
  }
  // Always keep the final sample so the outline closes where the user released
  const last = points[points.length - 1]!
  const [lx, ly] = out[out.length - 1]!
  if (lx !== last[0] || ly !== last[1]) out.push(last)
  return out
}

/** Centroid of a point set — the natural label anchor for a region. */
export function centroid(points: Point[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  return { x: sx / points.length, y: sy / points.length }
}
