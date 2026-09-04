import type { Annotation, AnnotationShape, Geometry, Point } from './types.js'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ANNOTATIONS_DIR = 'annotations'
const SCHEMA_VERSION = 2

function annotationsDir(projectRoot: string): string {
  return join(projectRoot, '.graphcoder', ANNOTATIONS_DIR)
}

function annotationPath(projectRoot: string, id: string): string {
  return join(annotationsDir(projectRoot), `${id}.json`)
}

/** Deep key sorting for canonical JSON */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

/** Canonical JSON — sorted keys, no extra whitespace, NFC normalized */
function canonicalStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj)).normalize('NFC')
}

/** Create a new annotation with defaults filled in */
export function createAnnotation(
  shape: AnnotationShape,
  label: string,
  members: string[] = [],
  opts: Partial<Omit<Annotation, 'id' | 'version' | 'shape' | 'createdAt' | 'updatedAt'>> = {}
): Annotation {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    version: SCHEMA_VERSION,
    shape,
    kind: opts.kind ?? '',
    status: opts.status ?? 'active',
    label,
    description: opts.description ?? '',
    members,
    geometry: opts.geometry ?? { points: [], anchor: { x: 0, y: 0 } },
    parentId: opts.parentId ?? null,
    childIds: opts.childIds ?? [],
    author: opts.author ?? 'human',
    createdAt: now,
    updatedAt: now,
    reasoning: opts.reasoning ?? null
  }
}

/** Ensure the annotations directory exists */
function ensureDir(projectRoot: string): void {
  const dir = annotationsDir(projectRoot)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Save an annotation to disk as canonical JSON */
export function saveAnnotation(projectRoot: string, annotation: Annotation): void {
  ensureDir(projectRoot)
  annotation.updatedAt = new Date().toISOString()
  const filePath = annotationPath(projectRoot, annotation.id)
  writeFileSync(filePath, canonicalStringify(annotation) + '\n', 'utf-8')
}

// ── Migration ────────────────────────────────────────────────────────────────

/** v1 kind → v2 shape. v1 kinds survive as the v2 free-form kind string. */
const V1_KIND_TO_SHAPE: Record<string, AnnotationShape> = {
  boundary: 'region',
  projection: 'region',
  path: 'polyline',
  note: 'point',
  question: 'point'
}

/** v1 statuses that no longer exist map onto the v2 set. */
const V1_STATUS_MAP: Record<string, Annotation['status']> = {
  draft: 'active',
  active: 'active',
  proposed: 'proposed',
  stale: 'stale',
  applied: 'active',
  resolved: 'active',
  dismissed: 'dismissed'
}

/**
 * Migrate a v1 annotation to the v2 model.
 *
 * v1 carried the meaning in a fixed `kind` enum and split structure across
 * `members`/`steps`/`anchor`. v2 puts structure in `shape` + `geometry` and
 * keeps the old kind name as the user-defined kind, so nothing is lost.
 */
function migrateV1(raw: Record<string, unknown>): Record<string, unknown> {
  const v1Kind = typeof raw.kind === 'string' ? raw.kind : 'note'
  const shape = V1_KIND_TO_SHAPE[v1Kind] ?? 'point'

  // v1 path annotations held ordered nodes in steps[].architectureNodeId.
  // Prefer that ordering over the unordered members bag.
  let members: string[] = Array.isArray(raw.members) ? (raw.members as string[]) : []
  if (shape === 'polyline' && Array.isArray(raw.steps)) {
    const stepMembers = (raw.steps as Array<Record<string, unknown>>)
      .map((s) => s.architectureNodeId)
      .filter((id): id is string => typeof id === 'string')
    if (stepMembers.length > 0) members = stepMembers
  }

  // v1 anchor {x, y, memberLayout:{points}} → v2 geometry {points, anchor}
  const anchor = raw.anchor as { x?: number; y?: number; memberLayout?: { points?: Point[] } } | undefined
  const geometry: Geometry = {
    points: Array.isArray(anchor?.memberLayout?.points) ? anchor.memberLayout.points : [],
    anchor: { x: anchor?.x ?? 0, y: anchor?.y ?? 0 }
  }

  const v1Status = typeof raw.status === 'string' ? raw.status : 'active'

  return {
    ...raw,
    version: SCHEMA_VERSION,
    shape,
    kind: v1Kind,
    status: V1_STATUS_MAP[v1Status] ?? 'active',
    members,
    geometry
  }
}

/**
 * Fill missing fields with safe defaults and migrate older schema versions.
 * Handles annotations persisted before a schema change and hand-edited files.
 */
function normalizeAnnotation(input: Record<string, unknown>): Annotation {
  // Anything without a v2 shape field came from v1 (or was hand-written)
  const raw = typeof input.shape === 'string' ? input : migrateV1(input)

  const geometryRaw = raw.geometry as Partial<Geometry> | undefined
  const anchorRaw = geometryRaw?.anchor as { x?: number; y?: number } | undefined

  return {
    id: (raw.id as string) ?? randomUUID(),
    version: (raw.version as number) ?? SCHEMA_VERSION,
    shape: (raw.shape as AnnotationShape) ?? 'point',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    status: (raw.status as Annotation['status']) ?? 'active',
    label: (raw.label as string) ?? '',
    description: (raw.description as string) ?? '',
    members: Array.isArray(raw.members) ? (raw.members as string[]) : [],
    geometry: {
      points: Array.isArray(geometryRaw?.points) ? (geometryRaw.points as Point[]) : [],
      anchor: { x: anchorRaw?.x ?? 0, y: anchorRaw?.y ?? 0 }
    },
    parentId: (raw.parentId as string) ?? null,
    childIds: Array.isArray(raw.childIds) ? (raw.childIds as string[]) : [],
    author: (raw.author as Annotation['author']) ?? 'human',
    createdAt: (raw.createdAt as string) ?? new Date().toISOString(),
    updatedAt: (raw.updatedAt as string) ?? new Date().toISOString(),
    reasoning: (raw.reasoning as string) ?? null
  }
}

// ── Load / delete ────────────────────────────────────────────────────────────

/** Load a single annotation by ID */
export function loadAnnotation(projectRoot: string, id: string): Annotation | null {
  const filePath = annotationPath(projectRoot, id)
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf-8')
  return normalizeAnnotation(JSON.parse(raw) as Record<string, unknown>)
}

/** Load all annotations from disk */
export function loadAllAnnotations(projectRoot: string): Annotation[] {
  const dir = annotationsDir(projectRoot)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.conversation.json'))
  const annotations: Annotation[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8')
      annotations.push(normalizeAnnotation(JSON.parse(raw) as Record<string, unknown>))
    } catch {
      // Skip malformed files
    }
  }
  return annotations
}

/** Delete an annotation file from disk */
export function deleteAnnotation(projectRoot: string, id: string): boolean {
  const filePath = annotationPath(projectRoot, id)
  if (!existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}

/** Get file mtime for cache comparison */
export function getAnnotationMtime(projectRoot: string, id: string): number | null {
  const filePath = annotationPath(projectRoot, id)
  if (!existsSync(filePath)) return null
  return statSync(filePath).mtimeMs
}
