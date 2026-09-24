/**
 * Annotation model — v3.
 *
 * Two orthogonal axes:
 *   - SHAPE  — derived from ordered + member count. Drives rendering.
 *   - KIND   — free-form, user-defined. Just a string.
 *
 * Committed format (on disk):
 *   { kind, label, description, ordered, members: [{id, ref, file, note}] }
 *
 * Runtime adds: id (slug from filename), shape, status, geometry.
 * AI proposals add: author, reasoning, status.
 */

export type AnnotationShape = 'region' | 'polyline' | 'point'

export type AnnotationStatus = 'active' | 'proposed' | 'stale' | 'dismissed'

export type Point = [number, number]

export interface Geometry {
  points: Point[]
  anchor: { x: number; y: number }
}

export interface AnnotationKind {
  name: string
  color: string
  description: string
  createdAt: string
}

/** A member reference — rich object with semantic ID + human-readable fields */
export interface AnnotationMember {
  /** Semantic ID (SHA-256 hash) — primary stable reference */
  id: string
  /** Human-readable qualified name — for git diff readability */
  ref: string
  /** File path — for git diff readability */
  file: string
  /** Per-member note */
  note: string
}

/** Runtime annotation — the full model used by server and client */
export interface Annotation {
  /** Slug (filename stem) — the annotation identifier */
  id: string

  /** Derived from ordered + member count */
  shape: AnnotationShape
  /** User-defined semantic label */
  kind: string
  /** Derived from member resolution */
  status: AnnotationStatus

  label: string
  description: string
  /** True for path/flow annotations where member order carries meaning */
  ordered: boolean
  /** Rich member references */
  members: AnnotationMember[]

  /** Drawn geometry — runtime only, not committed */
  geometry: Geometry

  /** AI proposals carry author and reasoning (not committed for accepted annotations) */
  author?: 'human' | 'agent'
  reasoning?: string | null
}

/** Derive the rendering shape from ordered flag + member count */
export function deriveShape(ordered: boolean, memberCount: number): AnnotationShape {
  if (ordered) return 'polyline'
  if (memberCount > 1) return 'region'
  return 'point'
}

// ── AI suggestion types ──────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  annotationDelta: Partial<Annotation> | null
}

export interface ConversationLog {
  annotationId: string
  provider: string
  sessionId: string | null
  turns: ConversationTurn[]
}

/** A human-readable node reference (what the AI produces) */
export interface NodeRef {
  name: string
  kind: string
  filePath: string
}

export interface NodeRefResolution {
  ref: NodeRef
  semanticId: string | null
  confidence: 'exact' | 'fuzzy' | 'unresolved'
}

export interface AISuggestedAnnotation {
  shape: AnnotationShape
  kind: string
  label: string
  description: string
  nodeRefs: NodeRef[]
  reasoning: string
}

export interface AISuggestResponse {
  annotations: AISuggestedAnnotation[]
  parentAnnotation: string | null
}
