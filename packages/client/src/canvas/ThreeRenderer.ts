/**
 * ThreeRenderer — WebGL graph renderer backed by Three.js.
 *
 * Draw calls: 4 total regardless of graph size.
 *   1. containerMesh  — InstancedBufferGeometry: all container boxes (package/dir/file/class)
 *   2. nodeMesh       — InstancedBufferGeometry: all node boxes
 *   3. edgeLines      — LineSegments2: all edge polyline segments (2 px screen-space)
 *   4. arrowMesh      — InstancedBufferGeometry: arrowhead triangles
 *   5. glyphMesh      — InstancedBufferGeometry: SDF glyph quads
 *
 * Coordinate system: Y-down matching ELK layout output.
 * Camera: OrthographicCamera with top=0, bottom=canvasH (Y increases downward).
 * Pan/zoom: world Group.position / .scale (camera stays fixed).
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  Group
} from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import RBush from 'rbush'
import type { GraphNode } from '@graphcoder/core'
import { nodeSemanticId } from '@graphcoder/core'
import { edgeKindColor, nodeKindColor } from '../constants.js'
import type { FileContainer, LayoutResult } from '../layout/elk.js'
import { buildSdfAtlas, type SdfAtlas } from './sdfAtlas.js'
import { RECT_VERT, RECT_FRAG, GLYPH_VERT, GLYPH_FRAG, ARROW_VERT, ARROW_FRAG } from './shaders.js'

// ── Capacity constants ────────────────────────────────────────────────────────

const MAX_CONTAINERS = 5_000
const MAX_NODES = 20_000
const MAX_EDGE_SEGS = 400_000 // total polyline segments across all edges
const MAX_ARROWS = 100_000
const MAX_GLYPHS = 600_000

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Unit quad: two triangles covering (0,0)..(1,1) in XY plane. */
function makeUnitQuad(): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
  return geo
}

/** Unit quad with corners at (-0.5,-0.5)..(0.5,0.5) — for rect shader. */
function makeCentredQuad(): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)
  )
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
  return geo
}

/** Arrow triangle: tip at (0,0), base at (-1, ±0.45). */
function makeArrowGeo(): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, -1, 0.45, 0, -1, -0.45, 0]), 3))
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1))
  return geo
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  const n = parseInt(h, 16)
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

// ── RBush ─────────────────────────────────────────────────────────────────────

interface HitItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
  kind: 'node' | 'container'
  collapsed: boolean
  label: string
  nodeKind?: string
  /** File path key for toggleGroupExpanded — matches fn.filePath used by the server. */
  filePath?: string
}

// ── Hit result (public) ───────────────────────────────────────────────────────

export type HitResult =
  | { kind: 'node'; id: string; label: string; nodeKind?: string }
  | { kind: 'container'; id: string; label: string; collapsed: boolean; filePath?: string }

// ── Edge hit data ─────────────────────────────────────────────────────────────

export interface EdgeHitData {
  id: string
  kind?: string
  source: string
  target: string
  pts: number[]
}

// ── Point-to-segment distance helper ─────────────────────────────────────────

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 0.0001) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ── InstancedBufferGeometry builder ──────────────────────────────────────────

interface RectArrays {
  center: Float32Array // 2 floats per instance
  size: Float32Array // 2
  fill: Float32Array // 4 (rgba)
  border: Float32Array // 4 (rgba)
  radii: Float32Array // 2 (cornerRadius, borderWidth)
  status: Float32Array // 1
  selected: Float32Array // 1
  hover: Float32Array // 1
}

function makeRectArrays(max: number): RectArrays {
  return {
    center: new Float32Array(max * 2),
    size: new Float32Array(max * 2),
    fill: new Float32Array(max * 4),
    border: new Float32Array(max * 4),
    radii: new Float32Array(max * 2),
    status: new Float32Array(max),
    selected: new Float32Array(max),
    hover: new Float32Array(max)
  }
}

function makeRectGeo(_max: number, arrays: RectArrays): InstancedBufferGeometry {
  const geo = new InstancedBufferGeometry()
  // Copy centred-quad geometry
  const quad = makeCentredQuad()
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  geo.setIndex(quad.getIndex())

  geo.setAttribute('iCenter', new InstancedBufferAttribute(arrays.center, 2))
  geo.setAttribute('iSize', new InstancedBufferAttribute(arrays.size, 2))
  geo.setAttribute('iFill', new InstancedBufferAttribute(arrays.fill, 4))
  geo.setAttribute('iBorder', new InstancedBufferAttribute(arrays.border, 4))
  geo.setAttribute('iRadii', new InstancedBufferAttribute(arrays.radii, 2))
  geo.setAttribute('iStatus', new InstancedBufferAttribute(arrays.status, 1))
  geo.setAttribute('iSelected', new InstancedBufferAttribute(arrays.selected, 1))
  geo.setAttribute('iHover', new InstancedBufferAttribute(arrays.hover, 1))
  geo.instanceCount = 0
  return geo
}

function setRectInstance(
  arrays: RectArrays,
  i: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  fill: [number, number, number, number],
  border: [number, number, number, number],
  cornerRadius: number,
  borderWidth: number,
  status = 0,
  selected = 0,
  hover = 0
): void {
  const b2 = i * 2,
    b4 = i * 4
  arrays.center[b2] = cx
  arrays.center[b2 + 1] = cy
  arrays.size[b2] = w
  arrays.size[b2 + 1] = h
  arrays.fill[b4] = fill[0]
  arrays.fill[b4 + 1] = fill[1]
  arrays.fill[b4 + 2] = fill[2]
  arrays.fill[b4 + 3] = fill[3]
  arrays.border[b4] = border[0]
  arrays.border[b4 + 1] = border[1]
  arrays.border[b4 + 2] = border[2]
  arrays.border[b4 + 3] = border[3]
  arrays.radii[b2] = cornerRadius
  arrays.radii[b2 + 1] = borderWidth
  arrays.status[i] = status
  arrays.selected[i] = selected
  arrays.hover[i] = hover
}

function markRectGeoNeedsUpdate(geo: InstancedBufferGeometry): void {
  for (const name of ['iCenter', 'iSize', 'iFill', 'iBorder', 'iRadii', 'iStatus', 'iSelected', 'iHover']) {
    ;(geo.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  }
}

// ── GlyphArrays ───────────────────────────────────────────────────────────────

interface GlyphArrays {
  pos: Float32Array // 2 (top-left x,y)
  size: Float32Array // 2 (quad w,h)
  uv0: Float32Array // 2 (atlas UV top-left)
  uv1: Float32Array // 2 (atlas UV bottom-right)
  col: Float32Array // 3 (rgb)
}

function makeGlyphArrays(max: number): GlyphArrays {
  return {
    pos: new Float32Array(max * 2),
    size: new Float32Array(max * 2),
    uv0: new Float32Array(max * 2),
    uv1: new Float32Array(max * 2),
    col: new Float32Array(max * 3)
  }
}

function makeGlyphGeo(_max: number, arrays: GlyphArrays): InstancedBufferGeometry {
  const geo = new InstancedBufferGeometry()
  const quad = makeUnitQuad()
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  geo.setIndex(quad.getIndex())

  geo.setAttribute('iGPos', new InstancedBufferAttribute(arrays.pos, 2))
  geo.setAttribute('iGSize', new InstancedBufferAttribute(arrays.size, 2))
  geo.setAttribute('iUv0', new InstancedBufferAttribute(arrays.uv0, 2))
  geo.setAttribute('iUv1', new InstancedBufferAttribute(arrays.uv1, 2))
  geo.setAttribute('iGCol', new InstancedBufferAttribute(arrays.col, 3))
  geo.instanceCount = 0
  return geo
}

function markGlyphGeoNeedsUpdate(geo: InstancedBufferGeometry): void {
  for (const name of ['iGPos', 'iGSize', 'iUv0', 'iUv1', 'iGCol']) {
    ;(geo.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  }
}

// ── ArrowArrays ───────────────────────────────────────────────────────────────

interface ArrowArrays {
  tip: Float32Array // 2
  angle: Float32Array // 1
  asize: Float32Array // 1
  col: Float32Array // 3
}

function makeArrowArrays(max: number): ArrowArrays {
  return {
    tip: new Float32Array(max * 2),
    angle: new Float32Array(max),
    asize: new Float32Array(max),
    col: new Float32Array(max * 3)
  }
}

function makeArrowGeoInstanced(_max: number, arrays: ArrowArrays): InstancedBufferGeometry {
  const geo = new InstancedBufferGeometry()
  const base = makeArrowGeo()
  geo.setAttribute('position', base.getAttribute('position'))
  geo.setIndex(base.getIndex())

  geo.setAttribute('iATip', new InstancedBufferAttribute(arrays.tip, 2))
  geo.setAttribute('iAAngle', new InstancedBufferAttribute(arrays.angle, 1))
  geo.setAttribute('iASize', new InstancedBufferAttribute(arrays.asize, 1))
  geo.setAttribute('iACol', new InstancedBufferAttribute(arrays.col, 3))
  geo.instanceCount = 0
  return geo
}

function markArrowGeoNeedsUpdate(geo: InstancedBufferGeometry): void {
  for (const name of ['iATip', 'iAAngle', 'iASize', 'iACol']) {
    ;(geo.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  }
}

// ── ThreeRenderer ─────────────────────────────────────────────────────────────

export type DiffOverlay = { added: Set<string>; modified: Set<string>; moved: Set<string> }

export class ThreeRenderer {
  private renderer: WebGLRenderer
  private scene: Scene
  private camera: OrthographicCamera
  private world: Group

  // Instance arrays (pre-allocated, reused every layout update)
  private contArrays: RectArrays
  private contGeo: InstancedBufferGeometry
  private nodeArrays: RectArrays
  private nodeGeo: InstancedBufferGeometry
  private arrowArrays: ArrowArrays
  private arrowGeo: InstancedBufferGeometry
  private glyphArrays: GlyphArrays
  private glyphGeo: InstancedBufferGeometry

  // Edge lines
  private edgeLinesGeo: LineSegmentsGeometry
  private edgeLines: LineSegments2
  private lineMat: LineMaterial

  // Hit-test spatial index (world coords)
  private rbush = new RBush<HitItem>()

  // Per-instance lookup maps (node/container id → instance index in their respective arrays)
  private nodeInstIdx = new Map<string, number>()
  private contInstIdx = new Map<string, number>()

  // Container world rects for screen-space positioning (tooltip/button anchoring)
  private contById = new Map<string, FileContainer>()

  // Edge segments for CPU hit-testing
  private edgeHitData: EdgeHitData[] = []

  // Hovered edge highlight line (separate LineSegments2 rendered above everything)
  private hoveredEdgeLinesGeo: LineSegmentsGeometry
  private hoveredEdgeLines: LineSegments2
  private hoveredLineMat: LineMaterial

  // Current hover state tracking (id-based to detect changes)
  private _hovNodeId: string | null = null
  private _hovContId: string | null = null
  private _hovEdgeIdx = -1
  // Corresponding instance indices (kept in sync with the maps above)
  private _hovNodeInst = -1
  private _hovContInst = -1

  // SDF atlas
  private atlas: SdfAtlas

  // Dimensions
  private canvasW = 0
  private canvasH = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)

    this.scene = new Scene()
    this.world = new Group()
    this.scene.add(this.world)

    this.camera = new OrthographicCamera(0, 1, 0, 1, -1000, 1000)
    this.camera.position.z = 100

    // Build SDF atlas
    this.atlas = buildSdfAtlas()

    // ── Container mesh ─────────────────────────────────────────────────────
    this.contArrays = makeRectArrays(MAX_CONTAINERS)
    this.contGeo = makeRectGeo(MAX_CONTAINERS, this.contArrays)
    const contMat = new ShaderMaterial({
      vertexShader: RECT_VERT,
      fragmentShader: RECT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide
    })
    const contMesh = new Mesh(this.contGeo, contMat)
    contMesh.renderOrder = 0
    contMesh.frustumCulled = false
    this.world.add(contMesh)

    // ── Node mesh ──────────────────────────────────────────────────────────
    this.nodeArrays = makeRectArrays(MAX_NODES)
    this.nodeGeo = makeRectGeo(MAX_NODES, this.nodeArrays)
    const nodeMat = new ShaderMaterial({
      vertexShader: RECT_VERT,
      fragmentShader: RECT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide
    })
    const nodeMesh = new Mesh(this.nodeGeo, nodeMat)
    nodeMesh.renderOrder = 2
    nodeMesh.frustumCulled = false
    this.world.add(nodeMesh)

    // ── Edge lines ─────────────────────────────────────────────────────────
    this.edgeLinesGeo = new LineSegmentsGeometry()
    this.lineMat = new LineMaterial({
      linewidth: 2,
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
      depthWrite: false
    })
    this.edgeLines = new LineSegments2(this.edgeLinesGeo, this.lineMat)
    this.edgeLines.renderOrder = 1
    this.edgeLines.frustumCulled = false
    this.world.add(this.edgeLines)

    // ── Arrow mesh ─────────────────────────────────────────────────────────
    this.arrowArrays = makeArrowArrays(MAX_ARROWS)
    this.arrowGeo = makeArrowGeoInstanced(MAX_ARROWS, this.arrowArrays)
    const arrowMat = new ShaderMaterial({
      vertexShader: ARROW_VERT,
      fragmentShader: ARROW_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide
    })
    const arrowMesh = new Mesh(this.arrowGeo, arrowMat)
    arrowMesh.renderOrder = 3
    arrowMesh.frustumCulled = false
    this.world.add(arrowMesh)

    // ── Glyph mesh ─────────────────────────────────────────────────────────
    this.glyphArrays = makeGlyphArrays(MAX_GLYPHS)
    this.glyphGeo = makeGlyphGeo(MAX_GLYPHS, this.glyphArrays)
    const glyphMat = new ShaderMaterial({
      vertexShader: GLYPH_VERT,
      fragmentShader: GLYPH_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uAtlas: { value: this.atlas.texture },
        uThreshold: { value: new Vector2(this.atlas.threshold.lo, this.atlas.threshold.hi) }
      },
      side: DoubleSide
    })
    const glyphMesh = new Mesh(this.glyphGeo, glyphMat)
    glyphMesh.renderOrder = 4
    glyphMesh.frustumCulled = false
    this.world.add(glyphMesh)

    // ── Hovered edge highlight line ────────────────────────────────────────
    // Rendered above all other geometry; only visible when an edge is hovered.
    this.hoveredEdgeLinesGeo = new LineSegmentsGeometry()
    this.hoveredLineMat = new LineMaterial({
      linewidth: 3,
      color: 0x60a5fa, // blue-400
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false
    })
    this.hoveredEdgeLines = new LineSegments2(this.hoveredEdgeLinesGeo, this.hoveredLineMat)
    this.hoveredEdgeLines.renderOrder = 5
    this.hoveredEdgeLines.frustumCulled = false
    this.hoveredEdgeLines.visible = false
    this.world.add(this.hoveredEdgeLines)
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  resize(w: number, h: number): void {
    this.canvasW = w
    this.canvasH = h
    this.renderer.setSize(w, h, false)
    // Y-down orthographic camera
    this.camera.left = 0
    this.camera.right = w
    this.camera.top = 0
    this.camera.bottom = h
    this.camera.updateProjectionMatrix()
    this.lineMat.resolution.set(w, h)
    this.hoveredLineMat.resolution.set(w, h)
  }

  // ── Set background colour ─────────────────────────────────────────────────

  setBackground(hex: number): void {
    this.renderer.setClearColor(hex, 1)
  }

  // ── Fit layout in view ────────────────────────────────────────────────────

  fitLayout(layoutW: number, layoutH: number): { panX: number; panY: number; zoom: number } {
    const margin = 48
    const scaleX = (this.canvasW - margin * 2) / layoutW
    const scaleY = (this.canvasH - margin * 2) / layoutH
    const zoom = Math.min(scaleX, scaleY, 2)
    const panX = (this.canvasW - layoutW * zoom) / 2
    const panY = (this.canvasH - layoutH * zoom) / 2
    return { panX, panY, zoom }
  }

  // ── Update world transform ────────────────────────────────────────────────

  applyCamera(panX: number, panY: number, zoom: number): void {
    this.world.position.set(panX, panY, 0)
    this.world.scale.set(zoom, zoom, 1)
    // Scale edge line width and opacity with zoom so co-routed edges don't form
    // thick opaque bands at overview zoom levels.
    // linewidth is in CSS pixels (screen-space); clamp to [0.5, 2].
    this.lineMat.linewidth = Math.max(0.5, Math.min(2, zoom * 6))
    // opacity: reduce at low zoom so overlapping lines stay legible
    this.lineMat.opacity = Math.max(0.2, Math.min(0.65, 0.2 + zoom * 1.5))
    // Hovered edge highlight scales with zoom too (always thicker than normal)
    this.hoveredLineMat.linewidth = Math.max(1.5, Math.min(4, zoom * 9))
  }

  // ── Hit test (returns node/container result or null) ──────────────────────

  hitTest(screenX: number, screenY: number, panX: number, panY: number, zoom: number): HitResult | null {
    const wx = (screenX - panX) / zoom
    const wy = (screenY - panY) / zoom
    const hits = this.rbush.search({ minX: wx - 0.5, minY: wy - 0.5, maxX: wx + 0.5, maxY: wy + 0.5 })
    if (hits.length === 0) return null
    // Return the hit with the smallest area (most specific — nodes before containers)
    hits.sort((a: HitItem, b: HitItem) => (a.maxX - a.minX) * (a.maxY - a.minY) - (b.maxX - b.minX) * (b.maxY - b.minY))
    const h = hits[0]
    if (h.kind === 'node') {
      return { kind: 'node', id: h.id, label: h.label, nodeKind: h.nodeKind }
    }
    return { kind: 'container', id: h.id, label: h.label, collapsed: h.collapsed, filePath: h.filePath }
  }

  // ── Edge CPU hit test ─────────────────────────────────────────────────────

  edgeHitTest(wx: number, wy: number, zoom: number): number {
    // Threshold in world units: generous at low zoom, tighter at high zoom.
    const threshold = Math.max(6, 14 / zoom)
    let best = Infinity
    let bestIdx = -1
    for (let i = 0; i < this.edgeHitData.length; i++) {
      const { pts } = this.edgeHitData[i]
      for (let k = 0; k < pts.length - 2; k += 2) {
        const dist = pointToSegmentDist(wx, wy, pts[k], pts[k + 1], pts[k + 2], pts[k + 3])
        if (dist < threshold && dist < best) {
          best = dist
          bestIdx = i
        }
      }
    }
    return bestIdx
  }

  // ── Get edge data by index ────────────────────────────────────────────────

  getEdgeData(idx: number): EdgeHitData | null {
    return this.edgeHitData[idx] ?? null
  }

  // ── Get container world rect ──────────────────────────────────────────────

  getContainerWorldRect(id: string): FileContainer | null {
    return this.contById.get(id) ?? null
  }

  // ── Lightweight hover update (no full scene rebuild) ───────────────────────

  setHovered(nodeId: string | null, containerId: string | null, edgeIdx: number): void {
    const sameNode = nodeId === this._hovNodeId
    const sameCont = containerId === this._hovContId
    const sameEdge = edgeIdx === this._hovEdgeIdx
    if (sameNode && sameCont && sameEdge) return

    // Clear previous node hover
    if (!sameNode && this._hovNodeInst >= 0) {
      this.nodeArrays.hover[this._hovNodeInst] = 0
      ;(this.nodeGeo.getAttribute('iHover') as InstancedBufferAttribute).needsUpdate = true
      this._hovNodeInst = -1
    }

    // Clear previous container hover
    if (!sameCont && this._hovContInst >= 0) {
      this.contArrays.hover[this._hovContInst] = 0
      ;(this.contGeo.getAttribute('iHover') as InstancedBufferAttribute).needsUpdate = true
      this._hovContInst = -1
    }

    this._hovNodeId = nodeId
    this._hovContId = containerId

    // Apply new node hover
    if (nodeId !== null) {
      const idx = this.nodeInstIdx.get(nodeId)
      if (idx !== undefined) {
        this.nodeArrays.hover[idx] = 1
        ;(this.nodeGeo.getAttribute('iHover') as InstancedBufferAttribute).needsUpdate = true
        this._hovNodeInst = idx
      }
    }

    // Apply new container hover
    if (containerId !== null) {
      const idx = this.contInstIdx.get(containerId)
      if (idx !== undefined) {
        this.contArrays.hover[idx] = 1
        ;(this.contGeo.getAttribute('iHover') as InstancedBufferAttribute).needsUpdate = true
        this._hovContInst = idx
      }
    }

    // Update hovered edge highlight
    if (!sameEdge) {
      this._hovEdgeIdx = edgeIdx
      if (edgeIdx < 0 || edgeIdx >= this.edgeHitData.length) {
        this.hoveredEdgeLines.visible = false
      } else {
        const { pts } = this.edgeHitData[edgeIdx]
        const positions: number[] = []
        for (let k = 0; k < pts.length - 2; k += 2) {
          positions.push(pts[k], pts[k + 1], 0, pts[k + 2], pts[k + 3], 0)
        }
        if (positions.length > 0) {
          this.hoveredEdgeLinesGeo.setPositions(new Float32Array(positions))
          this.hoveredEdgeLines.visible = true
        } else {
          this.hoveredEdgeLines.visible = false
        }
      }
    }

    this.render()
  }

  // ── Update scene from layout ──────────────────────────────────────────────

  updateScene(
    layout: LayoutResult,
    byId: Map<string, GraphNode>,
    selectedId: string | null,
    diff: DiffOverlay,
    isDark: boolean
  ): void {
    // Clear hit tree and lookup maps — hover state resets on layout change
    this.rbush.clear()
    this.nodeInstIdx.clear()
    this.contInstIdx.clear()
    this.contById.clear()
    this.edgeHitData = []

    // Reset hovered edge line
    this.hoveredEdgeLines.visible = false
    this._hovNodeId = null
    this._hovContId = null
    this._hovEdgeIdx = -1
    this._hovNodeInst = -1
    this._hovContInst = -1

    let ci = 0 // container instance index
    let ni = 0 // node instance index
    let ai = 0 // arrow instance index
    let gi = 0 // glyph instance index

    const edgePositions: number[] = []
    const edgeColors: number[] = []

    // ── Helpers ─────────────────────────────────────────────────────────────

    const parseHex = (hex: string): [number, number, number] => hexToRgb(hex)

    /** Push a container rect instance. Records instance index for hover updates. */
    const pushContainer = (
      fc: FileContainer,
      fillRgba: [number, number, number, number],
      borderRgba: [number, number, number, number],
      cornerR: number,
      borderW: number
    ): void => {
      if (ci >= MAX_CONTAINERS) return
      this.contInstIdx.set(fc.id, ci)
      this.contById.set(fc.id, fc)
      setRectInstance(
        this.contArrays,
        ci++,
        fc.x + fc.width / 2,
        fc.y + fc.height / 2,
        fc.width,
        fc.height,
        fillRgba,
        borderRgba,
        cornerR,
        borderW
      )
    }

    /** Push container label glyphs. */
    const pushLabel = (
      text: string,
      x: number,
      y: number,
      fontSize: number,
      colorRgb: [number, number, number],
      maxChars = 48
    ): void => {
      const { glyphs, cellH, advance } = this.atlas
      const scale = fontSize / 24
      const displayH = cellH * scale
      const displayAdv = advance * scale
      const str = text.length > maxChars ? `…${text.slice(-(maxChars - 1))}` : text
      let cx = x
      for (const ch of str) {
        if (gi >= MAX_GLYPHS) break
        const g = glyphs.get(ch) ?? glyphs.get('?')
        if (!g) {
          cx += displayAdv
          continue
        }
        const b2 = gi * 2,
          b3 = gi * 3
        this.glyphArrays.pos[b2] = cx
        this.glyphArrays.pos[b2 + 1] = y
        this.glyphArrays.size[b2] = g.cellW * scale
        this.glyphArrays.size[b2 + 1] = displayH
        this.glyphArrays.uv0[b2] = g.u0
        this.glyphArrays.uv0[b2 + 1] = g.v0
        this.glyphArrays.uv1[b2] = g.u1
        this.glyphArrays.uv1[b2 + 1] = g.v1
        this.glyphArrays.col[b3] = colorRgb[0]
        this.glyphArrays.col[b3 + 1] = colorRgb[1]
        this.glyphArrays.col[b3 + 2] = colorRgb[2]
        gi++
        cx += displayAdv
      }
    }

    // ── Package containers ────────────────────────────────────────────────────
    for (const pc of layout.packageContainers) {
      const fill: [number, number, number, number] = isDark ? [0.008, 0.028, 0.063, 0.5] : [0.804, 0.835, 0.878, 0.35]
      const border: [number, number, number, number] = isDark ? [0.118, 0.227, 0.373, 0.6] : [0.392, 0.455, 0.545, 0.45]
      pushContainer(pc, fill, border, 18, 1.5)
      if (ci > 0) {
        const c = isDark
          ? ([0.294, 0.416, 0.541] as [number, number, number])
          : ([0.278, 0.337, 0.435] as [number, number, number])
        pushLabel(pc.label.toUpperCase(), pc.x + 16, pc.y + 10, 11, c, 48)
      }
      this.rbush.insert({
        minX: pc.x,
        minY: pc.y,
        maxX: pc.x + pc.width,
        maxY: pc.y + pc.height,
        id: pc.id,
        kind: 'container',
        collapsed: false,
        label: pc.label,
        filePath: pc.filePath
      })
    }

    // ── Dir containers ────────────────────────────────────────────────────────
    for (const dc of layout.dirContainers) {
      const fill: [number, number, number, number] = isDark ? [0.024, 0.047, 0.094, 0.4] : [0.867, 0.894, 0.937, 0.4]
      const border: [number, number, number, number] = isDark ? [0.118, 0.176, 0.251, 0.45] : [0.58, 0.639, 0.722, 0.35]
      pushContainer(dc, fill, border, 14, 1)
      const short = dc.label.length > 48 ? `…${dc.label.slice(-47)}` : dc.label
      const c = isDark
        ? ([0.216, 0.255, 0.318] as [number, number, number])
        : ([0.392, 0.455, 0.545] as [number, number, number])
      pushLabel(short, dc.x + 12, dc.y + 8, 10, c)
      this.rbush.insert({
        minX: dc.x,
        minY: dc.y,
        maxX: dc.x + dc.width,
        maxY: dc.y + dc.height,
        id: dc.id,
        kind: 'container',
        collapsed: false,
        label: dc.label,
        filePath: dc.filePath
      })
    }

    // ── File + contract containers ────────────────────────────────────────────
    for (const fc of layout.containers) {
      let fill: [number, number, number, number]
      let border: [number, number, number, number]
      let labelColor: [number, number, number]
      let cornerR: number, borderW: number

      if (fc.collapsed) {
        // Collapsed file chip — solid, clearly distinct from the empty space inside dir containers.
        fill = isDark ? [0.098, 0.122, 0.196, 0.85] : [0.835, 0.859, 0.91, 0.9]
        border = isDark ? [0.302, 0.369, 0.506, 0.9] : [0.376, 0.447, 0.565, 0.85]
        labelColor = isDark ? [0.682, 0.737, 0.812] : [0.196, 0.247, 0.341]
        cornerR = 6
        borderW = 1.5
      } else if (fc.color) {
        const [r, g, b] = parseHex(fc.color)
        fill = [r, g, b, 0.07]
        border = [r, g, b, 0.6]
        labelColor = [r, g, b]
        cornerR = 10
        borderW = 2
      } else {
        fill = isDark ? [0.059, 0.09, 0.165, 0.55] : [0.886, 0.91, 0.941, 0.5]
        border = isDark ? [0.2, 0.255, 0.333, 0.8] : [0.58, 0.639, 0.722, 0.6]
        labelColor = isDark ? [0.42, 0.49, 0.573] : [0.278, 0.337, 0.435]
        cornerR = 8
        borderW = 1.5
      }
      pushContainer(fc, fill, border, cornerR, borderW)
      const short = fc.label.length > 32 ? `…${fc.label.slice(-31)}` : fc.label
      // Collapsed chips now use 2× node height; centre label vertically.
      // Expanded containers keep the label near the top (y+10).
      const chipLabelY = fc.collapsed ? fc.y + fc.height / 2 - 8 : fc.y + 10
      // Collapsed chips: prefix with `+` (ASCII, in atlas) to signal expandability.
      const displayLabel = fc.collapsed ? `+ ${short}` : short
      pushLabel(displayLabel, fc.x + (fc.color ? 12 : 10), chipLabelY, 11, labelColor)
      this.rbush.insert({
        minX: fc.x,
        minY: fc.y,
        maxX: fc.x + fc.width,
        maxY: fc.y + fc.height,
        id: fc.id,
        kind: 'container',
        collapsed: fc.collapsed ?? false,
        label: fc.label,
        filePath: fc.filePath
      })
    }

    // ── Class sub-containers ─────────────────────────────────────────────────
    for (const cc of layout.classContainers) {
      const [r, g, b] = [0.506, 0.549, 0.973] // #818cf8
      pushContainer(cc, [r, g, b, 0.07], [r, g, b, 0.6], 10, 2)
      pushLabel(cc.label, cc.x + 12, cc.y + 10, 11, [r, g, b])
      this.rbush.insert({
        minX: cc.x,
        minY: cc.y,
        maxX: cc.x + cc.width,
        maxY: cc.y + cc.height,
        id: cc.id,
        kind: 'container',
        collapsed: false,
        label: cc.label,
        filePath: cc.filePath
      })
    }

    this.contGeo.instanceCount = ci
    markRectGeoNeedsUpdate(this.contGeo)

    // ── Nodes ─────────────────────────────────────────────────────────────────
    for (const [id, ln] of layout.nodes) {
      if (ni >= MAX_NODES) break
      const gn = byId.get(id)
      const kind = gn?.kind
      const fillHex = nodeKindColor(kind, isDark)
      const [fr, fg, fb] = parseHex(fillHex)

      // Diff status
      let status = 0
      if (gn) {
        const semId = nodeSemanticId(gn)
        if (diff.added.has(semId)) status = 1
        else if (diff.modified.has(semId)) status = 2
        else if (diff.moved.has(semId)) status = 3
      }

      const sel = selectedId === id ? 1 : 0
      // Visible border so nodes contrast clearly against container backgrounds
      const borderC: [number, number, number, number] = isDark ? [0.2, 0.255, 0.333, 0.55] : [0.39, 0.455, 0.557, 0.8]

      this.nodeInstIdx.set(id, ni)
      setRectInstance(
        this.nodeArrays,
        ni,
        ln.x + ln.width / 2,
        ln.y + ln.height / 2,
        ln.width,
        ln.height,
        [fr, fg, fb, 1.0],
        borderC,
        4,
        1.5,
        status,
        sel
      )
      ni++

      // RBush entry (world coords) — nodes before containers (sorted by area, nodes win)
      const nodeName = gn?.name ?? id
      this.rbush.insert({
        minX: ln.x,
        minY: ln.y,
        maxX: ln.x + ln.width,
        maxY: ln.y + ln.height,
        id,
        kind: 'node',
        collapsed: false,
        label: nodeName,
        nodeKind: kind
      })

      // ── Node text ──────────────────────────────────────────────────────────
      const nameRaw = gn?.name ?? id
      const nameTrunc = nameRaw.length > 18 ? `${nameRaw.slice(0, 16)}…` : nameRaw
      const badgeStr = kind ?? ''

      const textScale = 11 / 24
      const { cellH, advance } = this.atlas
      const displayH = cellH * textScale

      // Name — left-aligned, vertically centred
      const nameColor: [number, number, number] = isDark ? [1, 1, 1] : [0.059, 0.09, 0.165]
      const nameY = ln.y + ln.height / 2 - displayH / 2
      pushLabel(nameTrunc, ln.x + 8, nameY, 11, nameColor, 18)

      // Badge — right-aligned, top of node
      if (badgeStr) {
        const badgeScale = 8 / 24
        const badgeAdv = advance * badgeScale
        const badgeW = badgeStr.length * badgeAdv
        const badgeColor: [number, number, number] = isDark ? [0.612, 0.639, 0.686] : [0.278, 0.337, 0.435]
        pushLabel(badgeStr, ln.x + ln.width - badgeW - 4, ln.y + 2, 8, badgeColor, 20)
      }
    }

    this.nodeGeo.instanceCount = ni
    markRectGeoNeedsUpdate(this.nodeGeo)

    // ── Edges + arrows ────────────────────────────────────────────────────────
    for (const edge of layout.edges) {
      const colorHex = edgeKindColor(edge.kind, isDark)
      const [er, eg, eb] = parseHex(colorHex)

      // Extract all polyline points for this edge
      const pts: number[] = []
      for (const section of edge.sections) {
        if (pts.length === 0) {
          pts.push(section.startPoint.x, section.startPoint.y)
        }
        for (const bp of section.bendPoints ?? []) {
          pts.push(bp.x, bp.y)
        }
        pts.push(section.endPoint.x, section.endPoint.y)
      }
      if (pts.length < 4) continue

      // Store for CPU edge hit-testing
      this.edgeHitData.push({ id: edge.id, kind: edge.kind, source: edge.source, target: edge.target, pts })

      // Push segments (each segment = one pair of points)
      for (let k = 0; k < pts.length - 2; k += 2) {
        if (edgePositions.length / 6 >= MAX_EDGE_SEGS) break
        const x0 = pts[k],
          y0 = pts[k + 1]
        const x1 = pts[k + 2],
          y1 = pts[k + 3]
        edgePositions.push(x0, y0, 0, x1, y1, 0)
        edgeColors.push(er, eg, eb, er, eg, eb)
      }

      // Arrowhead at last point
      if (ai < MAX_ARROWS) {
        const n = pts.length
        const ex = pts[n - 2],
          ey = pts[n - 1]
        const px = pts[n - 4],
          py = pts[n - 3]
        const angle = Math.atan2(ey - py, ex - px)
        const b2 = ai * 2,
          b3 = ai * 3
        this.arrowArrays.tip[b2] = ex
        this.arrowArrays.tip[b2 + 1] = ey
        this.arrowArrays.angle[ai] = angle
        this.arrowArrays.asize[ai] = 8
        this.arrowArrays.col[b3] = er
        this.arrowArrays.col[b3 + 1] = eg
        this.arrowArrays.col[b3 + 2] = eb
        ai++
      }
    }

    // Upload edge geometry
    if (edgePositions.length > 0) {
      this.edgeLinesGeo.setPositions(new Float32Array(edgePositions))
      this.edgeLinesGeo.setColors(new Float32Array(edgeColors))
      this.edgeLines.visible = true
    } else {
      this.edgeLines.visible = false
    }

    this.arrowGeo.instanceCount = ai
    markArrowGeoNeedsUpdate(this.arrowGeo)

    this.glyphGeo.instanceCount = gi
    markGlyphGeoNeedsUpdate(this.glyphGeo)

    this.render()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.contGeo.dispose()
    this.nodeGeo.dispose()
    this.arrowGeo.dispose()
    this.glyphGeo.dispose()
    this.edgeLinesGeo.dispose()
    this.hoveredEdgeLinesGeo.dispose()
    this.lineMat.dispose()
    this.hoveredLineMat.dispose()
    this.atlas.texture.dispose()
    this.renderer.dispose()
  }
}
