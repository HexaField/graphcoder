/**
 * shaders.ts — GLSL shaders for the Three.js graph renderer.
 *
 * Three.js automatically prepends:
 *   precision highp float;
 *   uniform mat4 projectionMatrix, modelViewMatrix, modelMatrix, viewMatrix;
 *   uniform mat3 normalMatrix;
 *
 * All shaders use GLSL ES 1.0 syntax (default Three.js ShaderMaterial).
 */

// ── Rounded-rect (nodes + containers) ────────────────────────────────────────

/**
 * Per-instance attributes:
 *   iCenter    vec2  — world-space center of the rect
 *   iSize      vec2  — pixel width and height
 *   iFill      vec4  — fill color (rgba)
 *   iBorder    vec4  — border color (rgba)
 *   iRadii     vec2  — (cornerRadius, borderWidth)
 *   iStatus    float — diff status: 0=none 1=added 2=modified 3=moved
 *   iSelected  float — 1 if selected
 *   iHover     float — 1 if hovered
 */
export const RECT_VERT = /* glsl */ `
attribute vec2 iCenter;
attribute vec2 iSize;
attribute vec4 iFill;
attribute vec4 iBorder;
attribute vec2 iRadii;
attribute float iStatus;
attribute float iSelected;
attribute float iHover;

varying vec2  vLocalPos;
varying vec2  vHalfSize;
varying vec4  vFill;
varying vec4  vBorder;
varying vec2  vRadii;
varying float vStatus;
varying float vSelected;
varying float vHover;

void main() {
  vHalfSize  = iSize * 0.5;
  vFill      = iFill;
  vBorder    = iBorder;
  vRadii     = iRadii;
  vStatus    = iStatus;
  vSelected  = iSelected;
  vHover     = iHover;
  // position.xy: -0.5..0.5 unit quad; map to pixel space centred on node
  vLocalPos  = position.xy * iSize;
  vec2 worldPos = iCenter + position.xy * iSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 0.0, 1.0);
}
`

export const RECT_FRAG = /* glsl */ `
varying vec2  vLocalPos;
varying vec2  vHalfSize;
varying vec4  vFill;
varying vec4  vBorder;
varying vec2  vRadii;
varying float vStatus;
varying float vSelected;
varying float vHover;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float r        = vRadii.x;
  float bw       = vRadii.y;
  float d        = sdRoundedBox(vLocalPos, vHalfSize - 0.5, r);
  float fillA    = 1.0 - smoothstep(-0.8, 0.8, d);
  if (fillA < 0.005) discard;

  // Border blend: smoothly transition fill → border colour near edge.
  // d < 0 inside shape; smoothstep(-bw,0,d) = 0 deep inside → pure fill,
  // approaches 1 near edge → blends toward border colour.
  float borderT  = smoothstep(-bw, 0.0, d);
  vec3  col      = mix(vFill.rgb, vBorder.rgb, borderT * vBorder.a);
  float alpha    = fillA * vFill.a;

  // Hover: brighten fill slightly (applied before selection ring)
  if (vHover > 0.5) {
    col   = mix(col, vec3(1.0, 1.0, 1.0), 0.13 * fillA);
    // Also add a thin inner highlight border
    float hd    = abs(d + bw * 0.8) - bw * 0.3;
    float hA    = 1.0 - smoothstep(-1.0, 1.0, hd);
    col         = mix(col, vec3(0.55, 0.72, 1.0), hA * 0.55);
    alpha       = max(alpha, hA * 0.45);
  }

  // Selection ring (blue outline outside the node)
  if (vSelected > 0.5) {
    float ring    = abs(d + bw + 1.0) - 1.5;
    float ringA   = 1.0 - smoothstep(-0.8, 0.8, ring);
    col           = mix(col, vec3(0.231, 0.510, 0.965), ringA * 0.95);
    alpha         = max(alpha, ringA * 0.95);
  }

  // Diff status ring (outside node, behind selection)
  if (vStatus > 0.5) {
    vec3  sc;
    if      (vStatus < 1.5) sc = vec3(0.133, 0.773, 0.369); // added
    else if (vStatus < 2.5) sc = vec3(0.961, 0.620, 0.043); // modified
    else                    sc = vec3(0.024, 0.714, 0.831); // moved
    float sring  = abs(d + bw + 3.5) - 2.0;
    float sringA = 1.0 - smoothstep(-0.8, 0.8, sring);
    col          = mix(col, sc, sringA * 0.85);
    alpha        = max(alpha, sringA * 0.85);
  }

  gl_FragColor = vec4(col, alpha);
}
`

// ── SDF glyph quads ───────────────────────────────────────────────────────────

/**
 * Per-instance attributes:
 *   iGPos   vec2  — top-left of glyph quad in world space
 *   iGSize  vec2  — quad width and height in world pixels
 *   iUv0    vec2  — atlas UV top-left
 *   iUv1    vec2  — atlas UV bottom-right
 *   iGCol   vec3  — text colour
 */
export const GLYPH_VERT = /* glsl */ `
attribute vec2 iGPos;
attribute vec2 iGSize;
attribute vec2 iUv0;
attribute vec2 iUv1;
attribute vec3 iGCol;

varying vec2 vAtlasUv;
varying vec3 vGCol;

void main() {
  // position.xy: 0..1 unit quad corners
  vec2 worldPos = iGPos + position.xy * iGSize;
  gl_Position   = projectionMatrix * modelViewMatrix * vec4(worldPos, 0.0, 1.0);
  vAtlasUv      = mix(iUv0, iUv1, position.xy);
  vGCol         = iGCol;
}
`

export const GLYPH_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec2      uThreshold;  // (lo, hi)

varying vec2 vAtlasUv;
varying vec3 vGCol;

void main() {
  // WebGL normalises Uint8 texture values to [0..1] in the shader.
  float sdf   = texture2D(uAtlas, vAtlasUv).a;
  float alpha = smoothstep(uThreshold.x, uThreshold.y, sdf);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vGCol, alpha);
}
`

// ── Arrowheads ────────────────────────────────────────────────────────────────

/**
 * Per-instance attributes:
 *   iATip   vec2  — tip position in world space
 *   iAAngle float — rotation angle (radians), 0 = points right
 *   iASize  float — half-length of the arrowhead in world pixels
 *   iACol   vec3  — colour
 */
export const ARROW_VERT = /* glsl */ `
attribute vec2  iATip;
attribute float iAAngle;
attribute float iASize;
attribute vec3  iACol;

varying vec3 vACol;

void main() {
  float c = cos(iAAngle);
  float s = sin(iAAngle);
  // position.xy: local triangle coords (tip at (0,0), base behind)
  vec2 local   = position.xy * iASize;
  vec2 rotated = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 world   = iATip + rotated;
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(world, 0.0, 1.0);
  vACol        = iACol;
}
`

export const ARROW_FRAG = /* glsl */ `
varying vec3 vACol;
void main() {
  gl_FragColor = vec4(vACol, 0.75);
}
`
