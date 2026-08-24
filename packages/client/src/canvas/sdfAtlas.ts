/**
 * sdfAtlas.ts — builds a single-channel SDF glyph atlas for printable ASCII.
 *
 * Uses @mapbox/tiny-sdf to generate signed distance fields from a monospace
 * canvas font. All 95 printable ASCII chars (0x20–0x7E) are packed into one
 * DataTexture so the glyph renderer can do a single draw call.
 *
 * Encoding: alpha channel = SDF value (0 = far outside, 255 = deep inside).
 * At the glyph edge: alpha ≈ 191 (0.75 × 255, with default cutoff=0.25).
 * Shader threshold: smoothstep(0.68, 0.78, a/255).
 */

import TinySDF from '@mapbox/tiny-sdf'
import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three'

// ── Public chars ──────────────────────────────────────────────────────────────

/** All 95 printable ASCII characters (U+0020 – U+007E). */
export const PRINTABLE_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' + 'abcdefghijklmnopqrstuvwxyz{|}~'

// ── Public types ──────────────────────────────────────────────────────────────

export interface GlyphInfo {
  /** Atlas UV coordinates (0..1) — top-left and bottom-right. */
  u0: number
  v0: number
  u1: number
  v1: number
  /** Pixel advance width (same for all chars in a monospace font). */
  glyphAdvance: number
  /**
   * Actual glyph bitmap dimensions (ink bounding box + 2×buffer on each side).
   * These differ per character — '.' is much smaller than 'M'.
   * The quad in the renderer must match these exactly so the SDF is not stretched.
   */
  cellW: number
  cellH: number
  /**
   * Pixels from baseline to glyph top (= Math.ceil(actualBoundingBoxAscent)).
   * Used to baseline-align glyphs: smaller glyphTop chars shift down relative
   * to the reference character so all share the same baseline position.
   */
  glyphTop: number
}

export interface SdfAtlas {
  texture: DataTexture
  glyphs: Map<string, GlyphInfo>
  /** Reference cell dimensions — from 'M', the tallest glyph. Used for layout math. */
  cellW: number
  cellH: number
  /** Pixel advance width (monospace — same for every char). */
  advance: number
  /** SDF rendering threshold for solid fill (shader: smoothstep(lo, hi, sdf)). */
  threshold: { lo: number; hi: number }
  /**
   * glyphTop of the reference character ('M').
   * Used in pushLabel: each character's quad Y is offset by
   * (refGlyphTop - g.glyphTop) * scale so all glyphs share the same baseline.
   */
  refGlyphTop: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildSdfAtlas(): SdfAtlas {
  const FONT_SIZE = 24
  const BUFFER = 4
  const RADIUS = 8
  const CUTOFF = 0.25

  const sdf = new TinySDF({
    fontSize: FONT_SIZE,
    fontFamily: 'monospace',
    buffer: BUFFER,
    radius: RADIUS,
    cutoff: CUTOFF
  })

  // Measure cell dimensions from a tall character
  const sampleM = sdf.draw('M')
  const cellW = sampleM.width
  const cellH = sampleM.height

  // Grid layout — ceil(sqrt(95)) ≈ 10 cols × 10 rows
  const COLS = Math.ceil(Math.sqrt(PRINTABLE_CHARS.length))
  const ROWS = Math.ceil(PRINTABLE_CHARS.length / COLS)
  const atlasW = nextPow2(COLS * cellW)
  const atlasH = nextPow2(ROWS * cellH)

  // RGBA texture: R=G=B=255 (white), A=SDF value
  const atlasData = new Uint8Array(atlasW * atlasH * 4)
  // Pre-fill R/G/B channels to white; A will be set per-pixel
  for (let i = 0; i < atlasData.length; i += 4) {
    atlasData[i] = 255
    atlasData[i + 1] = 255
    atlasData[i + 2] = 255
    atlasData[i + 3] = 0
  }

  const glyphs = new Map<string, GlyphInfo>()
  let advance = sampleM.glyphAdvance

  for (let i = 0; i < PRINTABLE_CHARS.length; i++) {
    const char = PRINTABLE_CHARS[i]
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const g = sdf.draw(char)

    const startX = col * cellW
    const startY = row * cellH

    // Blit glyph into atlas alpha channel
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const atlasIdx = ((startY + y) * atlasW + (startX + x)) * 4
        atlasData[atlasIdx + 3] = g.data[y * g.width + x]
      }
    }

    if (g.glyphAdvance > 0) advance = g.glyphAdvance

    // V coordinates: inverted because flipY=true flips the atlas on GPU upload.
    // With flipY=true: data row 0 → UV.v=1, data row r → UV.v = 1 - r/atlasH.
    // v0 = glyph top UV (larger), v1 = glyph bottom UV (smaller).
    //
    // cellW/cellH store the ACTUAL glyph bitmap dimensions (not the reference M
    // dimensions). The renderer quad must match these so the SDF is not stretched.
    glyphs.set(char, {
      u0: startX / atlasW,
      v0: 1 - startY / atlasH,
      u1: (startX + g.width) / atlasW,
      v1: 1 - (startY + g.height) / atlasH,
      glyphAdvance: g.glyphAdvance,
      glyphTop: g.glyphTop,
      cellW: g.width,
      cellH: g.height
    })
  }

  const texture = new DataTexture(atlasData, atlasW, atlasH, RGBAFormat, UnsignedByteType)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  // flipY=true: data row 0 maps to UV.v=1 (OpenGL top), matching the inverted v0/v1 values above.
  texture.flipY = true
  texture.needsUpdate = true

  // TinySDF edge threshold: value at d=0 is (1-0/radius)*0.5 + cutoff = 0.5 + 0.25 = 0.75
  const edgeVal = 0.5 + CUTOFF
  return {
    texture,
    glyphs,
    cellW,
    cellH,
    advance,
    threshold: { lo: edgeVal - 0.05, hi: edgeVal + 0.05 },
    // glyphTop of 'M': Math.ceil(actualBoundingBoxAscent) = cap height in pixels.
    // Other glyphs offset their quad by (refGlyphTop - g.glyphTop) * scale so
    // all characters share the same baseline position.
    refGlyphTop: sampleM.glyphTop
  }
}
