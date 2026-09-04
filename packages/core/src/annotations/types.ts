/** Annotation kinds — the five cognitive gestures */
export type AnnotationKind = 'boundary' | 'path' | 'note' | 'question' | 'projection'

/** Annotation status lifecycle */
export type AnnotationStatus = 'draft' | 'active' | 'proposed' | 'stale' | 'applied' | 'resolved' | 'dismissed'

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

/** The AI's structured response when suggesting annotations */
export interface AISuggestResponse {
  annotations: AISuggestedAnnotation[]
  parentAnnotation: string | null // label or UUID of existing annotation
}

/** A single annotation suggested by the AI */
export interface AISuggestedAnnotation {
  kind: AnnotationKind
  label: string
  description: string
  nodeRefs: NodeRef[]
  steps?: Array<{
    label: string
    description: string
    nodeRef: NodeRef
    stepKind: StepKind
  }>
  reasoning: string
}

/** Step kinds for path annotations */
export type StepKind = 'entry' | 'process' | 'decision' | 'exit' | 'ux-only'

/** A single step in a path annotation */
export interface PathStep {
  id: string
  label: string
  description: string
  /** Semantic ID of the architecture node this step anchors to (nullable for ux-only steps) */
  architectureNodeId: string | null
  stepKind: StepKind
}

/** A directed connection between two path steps */
export interface StepEdge {
  from: string // step ID
  to: string // step ID
  label: string | null
}

/** Canvas anchor position for rendering */
export interface AnnotationAnchor {
  x: number
  y: number
  /** Boundary hull or path route — derived from member positions when null */
  memberLayout: null | { points: [number, number][] }
}

/** The unified annotation type — all five kinds share this shape */
export interface Annotation {
  id: string // UUID, immutable after creation
  version: number // schema version for migration
  kind: AnnotationKind
  status: AnnotationStatus
  label: string
  description: string

  /** Architecture nodes this annotation references (semantic IDs) */
  members: string[]

  /** Path-specific (kind: "path") */
  steps: PathStep[] | null
  stepEdges: StepEdge[] | null

  /** Projection-specific (kind: "projection") — ArchDiff object */
  projectedDiff: import('../diff/types.js').ArchDiff | null
  /** Projection dependency ordering (annotation UUIDs) */
  dependencies: string[]

  /** Question-specific (kind: "question") — answer text when resolved */
  resolution: string | null

  /** Composition — parent/child nesting */
  parentId: string | null
  childIds: string[]

  /** Canvas position */
  anchor: AnnotationAnchor

  /** Metadata */
  author: 'human' | 'agent'
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601

  /** AI reasoning behind the annotation (proposed annotations only) */
  reasoning: string | null
}
