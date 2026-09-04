/**
 * Annotation model.
 *
 * Two orthogonal axes:
 *   - SHAPE  — how it was drawn. Determines rendering. Fixed vocabulary.
 *   - KIND   — what it means. Free-form, user-defined. Just a string.
 *
 * The user never picks a shape from a menu; the drawing gesture decides it.
 * The user names the kind, and the kind registry remembers it for next time.
 */

/** How an annotation was drawn — drives rendering, carries no meaning */
export type AnnotationShape = 'region' | 'polyline' | 'point'

/** Annotation lifecycle */
export type AnnotationStatus = 'active' | 'proposed' | 'stale' | 'dismissed'

/** A vertex in graph world coordinates */
export type Point = [number, number]

/** The drawn geometry, in graph world coordinates */
export interface Geometry {
  /** Outline vertices (region) or waypoints (polyline). Empty for point. */
  points: Point[]
  /** Pin position and label anchor */
  anchor: { x: number; y: number }
}

/**
 * A user-defined annotation kind. Created on first use — typing a new
 * name in the inline input registers it with an auto-assigned colour.
 */
export interface AnnotationKind {
  /** Unique, user-typed. Case-preserved, matched case-insensitively. */
  name: string
  /** Hex colour used for every annotation of this kind */
  color: string
  description: string
  createdAt: string
}

/** The unified annotation — one shape, one user-defined kind */
export interface Annotation {
  id: string // UUID, immutable after creation
  version: number // schema version for migration

  /** Gesture-determined structure */
  shape: AnnotationShape
  /** User-defined semantic label. Empty string means unkinded. */
  kind: string
  status: AnnotationStatus

  label: string
  description: string

  /**
   * Architecture nodes this annotation covers (semantic IDs).
   * ORDER IS SIGNIFICANT for polyline shapes — it is the traversal order.
   */
  members: string[]

  /** The drawn shape */
  geometry: Geometry

  /** Composition — parent/child nesting */
  parentId: string | null
  childIds: string[]

  /** Metadata */
  author: 'human' | 'agent'
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601

  /** AI reasoning behind the annotation (proposed annotations only) */
  reasoning: string | null
}

// ── AI suggestion types ──────────────────────────────────────────────────────

/** A single turn in a refinement conversation */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: string // ISO 8601
  /** Partial annotation update returned by the AI (assistant turns only) */
  annotationDelta: Partial<Annotation> | null
}

/** Full conversation log for a proposed annotation */
export interface ConversationLog {
  annotationId: string
  provider: string
  /** Provider-specific session handle for resuming the conversation */
  sessionId: string | null
  turns: ConversationTurn[]
}

/** A human-readable node reference (what the AI produces) */
export interface NodeRef {
  name: string
  kind: string
  filePath: string
}

/** Resolution result for a single nodeRef */
export interface NodeRefResolution {
  ref: NodeRef
  semanticId: string | null
  confidence: 'exact' | 'fuzzy' | 'unresolved'
}

/** A single annotation suggested by the AI */
export interface AISuggestedAnnotation {
  /** Structure the AI chose for this suggestion */
  shape: AnnotationShape
  /** Free-form kind — the AI may reuse an existing kind or coin a new one */
  kind: string
  label: string
  description: string
  /** Ordered for polyline shapes */
  nodeRefs: NodeRef[]
  reasoning: string
}

/** The AI's structured response when suggesting annotations */
export interface AISuggestResponse {
  annotations: AISuggestedAnnotation[]
  parentAnnotation: string | null // label or UUID of existing annotation
}
