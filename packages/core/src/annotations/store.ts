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

/** Load a single annotation by ID */
export function loadAnnotation(projectRoot: string, id: string): Annotation | null {
  const filePath = annotationPath(projectRoot, id)
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as Annotation
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
      annotations.push(JSON.parse(raw) as Annotation)
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
