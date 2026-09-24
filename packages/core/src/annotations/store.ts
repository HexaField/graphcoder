import type { Annotation, AnnotationMember, AnnotationShape, Geometry } from './types.js'
import { deriveShape } from './types.js'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'

const ANNOTATIONS_DIR = 'annotations'

function annotationsDir(projectRoot: string): string {
  return join(projectRoot, '.graphcoder', ANNOTATIONS_DIR)
}

function annotationPath(projectRoot: string, slug: string): string {
  return join(annotationsDir(projectRoot), `${slug}.json`)
}

// ── Slug generation ─────────────────────────────────────────────────────────

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'untitled'
}

function uniqueSlug(projectRoot: string, label: string): string {
  const base = slugify(label)
  const dir = annotationsDir(projectRoot)
  if (!existsSync(join(dir, `${base}.json`))) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!existsSync(join(dir, `${candidate}.json`))) return candidate
  }
  return `${base}-${Date.now()}`
}

// ── Canonical JSON ──────────────────────────────────────────────────────────

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

function canonicalStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj), null, 2).normalize('NFC')
}

// ── v3 committed format ─────────────────────────────────────────────────────

interface CommittedAnnotation {
  kind: string
  label: string
  description: string
  ordered: boolean
  members: AnnotationMember[]
  status?: string
  author?: string
  reasoning?: string
}

function toCommitted(annotation: Annotation): CommittedAnnotation {
  const committed: CommittedAnnotation = {
    description: annotation.description,
    kind: annotation.kind,
    label: annotation.label,
    members: annotation.members,
    ordered: annotation.ordered
  }
  if (annotation.status === 'proposed') committed.status = 'proposed'
  if (annotation.author === 'agent') committed.author = 'agent'
  if (annotation.reasoning) committed.reasoning = annotation.reasoning
  return committed
}

// ── Format detection + normalization ────────────────────────────────────────

function isV3Format(raw: Record<string, unknown>): boolean {
  if (typeof raw.ordered !== 'boolean') return false
  if (!Array.isArray(raw.members)) return false
  if (raw.members.length === 0) return true
  const first = raw.members[0]
  return typeof first === 'object' && first !== null && 'id' in first
}

function normalizeV3(raw: Record<string, unknown>, slug: string): Annotation {
  const ordered = raw.ordered === true
  const members: AnnotationMember[] = Array.isArray(raw.members)
    ? (raw.members as Array<Record<string, unknown>>).map((m) => ({
        id: String(m.id ?? ''),
        ref: String(m.ref ?? ''),
        file: String(m.file ?? ''),
        note: String(m.note ?? '')
      }))
    : []

  const status = raw.status === 'proposed' ? ('proposed' as const) : ('active' as const)

  return {
    id: slug,
    shape: deriveShape(ordered, members.length),
    kind: String(raw.kind ?? ''),
    status,
    label: String(raw.label ?? ''),
    description: String(raw.description ?? ''),
    ordered,
    members,
    geometry: { points: [], anchor: { x: 0, y: 0 } },
    author: raw.author === 'agent' ? 'agent' : undefined,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : null
  }
}

/** v2 had shape as string, members as string[], version field */
const V1_KIND_TO_SHAPE: Record<string, AnnotationShape> = {
  boundary: 'region',
  projection: 'region',
  path: 'polyline',
  note: 'point',
  question: 'point'
}

function normalizeV2OrV1(raw: Record<string, unknown>, slug: string): Annotation {
  let shape: AnnotationShape
  let ordered: boolean
  let memberStrings: string[]

  if (typeof raw.shape === 'string') {
    shape = (raw.shape as AnnotationShape) ?? 'point'
    ordered = shape === 'polyline'
    memberStrings = Array.isArray(raw.members) ? (raw.members as string[]) : []
  } else {
    const v1Kind = typeof raw.kind === 'string' ? raw.kind : 'note'
    shape = V1_KIND_TO_SHAPE[v1Kind] ?? 'point'
    ordered = shape === 'polyline'
    memberStrings = Array.isArray(raw.members) ? (raw.members as string[]) : []
    if (shape === 'polyline' && Array.isArray(raw.steps)) {
      const stepMembers = (raw.steps as Array<Record<string, unknown>>)
        .map((s) => s.architectureNodeId)
        .filter((id): id is string => typeof id === 'string')
      if (stepMembers.length > 0) memberStrings = stepMembers
    }
  }

  const members: AnnotationMember[] = memberStrings.map((id) => ({
    id: typeof id === 'string' ? id : String(id),
    ref: '',
    file: '',
    note: ''
  }))

  const geometryRaw = raw.geometry as { points?: unknown[]; anchor?: { x?: number; y?: number } } | undefined

  const statusRaw = typeof raw.status === 'string' ? raw.status : 'active'
  const STATUS_MAP: Record<string, Annotation['status']> = {
    draft: 'active',
    active: 'active',
    proposed: 'proposed',
    stale: 'stale',
    applied: 'active',
    resolved: 'active',
    dismissed: 'dismissed'
  }

  return {
    id: slug,
    shape,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    status: STATUS_MAP[statusRaw] ?? 'active',
    label: String(raw.label ?? ''),
    description: String(raw.description ?? ''),
    ordered,
    members,
    geometry: {
      points: Array.isArray(geometryRaw?.points) ? (geometryRaw.points as Annotation['geometry']['points']) : [],
      anchor: { x: geometryRaw?.anchor?.x ?? 0, y: geometryRaw?.anchor?.y ?? 0 }
    },
    author: raw.author === 'agent' ? 'agent' : raw.author === 'human' ? 'human' : undefined,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : null
  }
}

function normalizeAnnotation(raw: Record<string, unknown>, slug: string): Annotation {
  if (isV3Format(raw)) return normalizeV3(raw, slug)
  return normalizeV2OrV1(raw, slug)
}

// ── Public API ──────────────────────────────────────────────────────────────

function ensureDir(projectRoot: string): void {
  const dir = annotationsDir(projectRoot)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function createAnnotation(
  label: string,
  members: AnnotationMember[],
  opts: {
    kind?: string
    description?: string
    ordered?: boolean
    status?: Annotation['status']
    author?: 'human' | 'agent'
    reasoning?: string | null
    geometry?: Geometry
  } = {}
): Annotation {
  const ordered = opts.ordered ?? false
  return {
    id: '',
    shape: deriveShape(ordered, members.length),
    kind: opts.kind ?? '',
    status: opts.status ?? 'active',
    label,
    description: opts.description ?? '',
    ordered,
    members,
    geometry: opts.geometry ?? { points: [], anchor: { x: 0, y: 0 } },
    author: opts.author,
    reasoning: opts.reasoning ?? null
  }
}

export function saveAnnotation(projectRoot: string, annotation: Annotation): string {
  ensureDir(projectRoot)
  const slug = annotation.id || uniqueSlug(projectRoot, annotation.label)
  annotation.id = slug
  const filePath = annotationPath(projectRoot, slug)
  writeFileSync(filePath, canonicalStringify(toCommitted(annotation)) + '\n', 'utf-8')
  return slug
}

export function loadAnnotation(projectRoot: string, slug: string): Annotation | null {
  const filePath = annotationPath(projectRoot, slug)
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    return normalizeAnnotation(raw, slug)
  } catch {
    return null
  }
}

export function loadAllAnnotations(projectRoot: string): Annotation[] {
  const dir = annotationsDir(projectRoot)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.conversation.json'))
  const annotations: Annotation[] = []
  for (const file of files) {
    try {
      const slug = basename(file, '.json')
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>
      annotations.push(normalizeAnnotation(raw, slug))
    } catch {
      // skip malformed
    }
  }
  return annotations
}

export function deleteAnnotation(projectRoot: string, slug: string): boolean {
  const filePath = annotationPath(projectRoot, slug)
  if (!existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}

export function renameAnnotationFile(projectRoot: string, oldSlug: string, newSlug: string): boolean {
  const oldPath = annotationPath(projectRoot, oldSlug)
  const newPath = annotationPath(projectRoot, newSlug)
  if (!existsSync(oldPath) || existsSync(newPath)) return false
  renameSync(oldPath, newPath)
  return true
}

export { slugify as generateSlug }
