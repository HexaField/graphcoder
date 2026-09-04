import type { Annotation, AnnotationKind } from './types.js'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ANNOTATIONS_DIR = 'annotations'
const SCHEMA_VERSION = 1

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
  kind: AnnotationKind,
  label: string,
  members: string[] = [],
  opts: Partial<Omit<Annotation, 'id' | 'version' | 'kind' | 'createdAt' | 'updatedAt'>> = {}
): Annotation {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    version: SCHEMA_VERSION,
    kind,
    status: opts.status ?? 'active',
    label,
    description: opts.description ?? '',
    members,
    steps: opts.steps ?? null,
    stepEdges: opts.stepEdges ?? null,
    projectedDiff: opts.projectedDiff ?? null,
    dependencies: opts.dependencies ?? [],
    resolution: opts.resolution ?? null,
    parentId: opts.parentId ?? null,
    childIds: opts.childIds ?? [],
    anchor: opts.anchor ?? { x: 0, y: 0, memberLayout: null },
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

/**
 * Fill missing fields with safe defaults. Handles annotations persisted
 * before a schema change or hand-edited files with omitted fields.
 */
function normalizeAnnotation(raw: Record<string, unknown>): Annotation {
  return {
    id: (raw.id as string) ?? randomUUID(),
    version: (raw.version as number) ?? SCHEMA_VERSION,
    kind: (raw.kind as Annotation['kind']) ?? 'note',
    status: (raw.status as Annotation['status']) ?? 'active',
    label: (raw.label as string) ?? '',
    description: (raw.description as string) ?? '',
    members: Array.isArray(raw.members) ? (raw.members as string[]) : [],
    steps: (raw.steps as Annotation['steps']) ?? null,
    stepEdges: (raw.stepEdges as Annotation['stepEdges']) ?? null,
    projectedDiff: (raw.projectedDiff as Annotation['projectedDiff']) ?? null,
    dependencies: Array.isArray(raw.dependencies) ? (raw.dependencies as string[]) : [],
    resolution: (raw.resolution as string) ?? null,
    parentId: (raw.parentId as string) ?? null,
    childIds: Array.isArray(raw.childIds) ? (raw.childIds as string[]) : [],
    anchor: (raw.anchor as Annotation['anchor']) ?? { x: 0, y: 0, memberLayout: null },
    author: (raw.author as Annotation['author']) ?? 'human',
    createdAt: (raw.createdAt as string) ?? new Date().toISOString(),
    updatedAt: (raw.updatedAt as string) ?? new Date().toISOString(),
    reasoning: (raw.reasoning as string) ?? null
  }
}

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
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
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
