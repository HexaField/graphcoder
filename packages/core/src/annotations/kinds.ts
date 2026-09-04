/**
 * Annotation kind registry.
 *
 * Kinds are user-defined, created on first use. Typing a new name in the
 * inline kind input registers it here with an auto-assigned colour. The
 * registry exists so kinds keep a stable colour and can be listed for
 * autocomplete — it never constrains what a user may type.
 */
import type { AnnotationKind } from './types.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const KINDS_FILE = 'annotation-kinds.json'

/**
 * Colour palette for auto-assignment. Chosen for distinguishability on both
 * light and dark canvas backgrounds.
 */
const PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16' // lime
]

function kindsPath(projectRoot: string): string {
  return join(projectRoot, '.graphcoder', KINDS_FILE)
}

/** Kind names match case-insensitively but keep the case the user typed. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** Deterministic colour choice so a given kind name always gets the same hue. */
function colorForName(name: string, taken: Set<string>): string {
  // Prefer an unused palette entry, seeded by the name hash for stability
  let hash = 0
  const key = normalizeName(name)
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  const start = hash % PALETTE.length
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = PALETTE[(start + i) % PALETTE.length]!
    if (!taken.has(candidate)) return candidate
  }
  // Every palette colour in use — fall back to the hashed entry
  return PALETTE[start]!
}

/** Load the kind registry. Returns an empty list when no file exists yet. */
export function loadKinds(projectRoot: string): AnnotationKind[] {
  const filePath = kindsPath(projectRoot)
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((k): k is Record<string, unknown> => typeof k === 'object' && k !== null)
      .map((k) => ({
        name: (k.name as string) ?? '',
        color: (k.color as string) ?? PALETTE[0]!,
        description: (k.description as string) ?? '',
        createdAt: (k.createdAt as string) ?? new Date().toISOString()
      }))
      .filter((k) => k.name.length > 0)
  } catch {
    return []
  }
}

/** Write the kind registry to disk. */
export function saveKinds(projectRoot: string, kinds: AnnotationKind[]): void {
  const filePath = kindsPath(projectRoot)
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(kinds, null, 2) + '\n', 'utf-8')
}

/** Find a kind by name, case-insensitively. */
export function findKind(kinds: AnnotationKind[], name: string): AnnotationKind | null {
  const key = normalizeName(name)
  return kinds.find((k) => normalizeName(k.name) === key) ?? null
}

/**
 * Register a kind if it does not exist yet, assigning a colour automatically.
 * Returns the existing or newly created kind. Blank names are ignored.
 */
export function ensureKind(projectRoot: string, name: string, description = ''): AnnotationKind | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return null

  const kinds = loadKinds(projectRoot)
  const existing = findKind(kinds, trimmed)
  if (existing) return existing

  const taken = new Set(kinds.map((k) => k.color))
  const created: AnnotationKind = {
    name: trimmed,
    color: colorForName(trimmed, taken),
    description,
    createdAt: new Date().toISOString()
  }
  kinds.push(created)
  saveKinds(projectRoot, kinds)
  return created
}

/** Update a kind's colour, description, or name. Returns the updated kind. */
export function updateKind(
  projectRoot: string,
  name: string,
  updates: Partial<Pick<AnnotationKind, 'name' | 'color' | 'description'>>
): AnnotationKind | null {
  const kinds = loadKinds(projectRoot)
  const existing = findKind(kinds, name)
  if (!existing) return null

  if (updates.name !== undefined) {
    const renamed = updates.name.trim()
    // Refuse a rename that would collide with a different existing kind
    const collision = findKind(kinds, renamed)
    if (renamed.length === 0 || (collision && collision !== existing)) return null
    existing.name = renamed
  }
  if (updates.color !== undefined) existing.color = updates.color
  if (updates.description !== undefined) existing.description = updates.description

  saveKinds(projectRoot, kinds)
  return existing
}

/** Remove a kind from the registry. Annotations keep their kind string. */
export function deleteKind(projectRoot: string, name: string): boolean {
  const kinds = loadKinds(projectRoot)
  const key = normalizeName(name)
  const next = kinds.filter((k) => normalizeName(k.name) !== key)
  if (next.length === kinds.length) return false
  saveKinds(projectRoot, next)
  return true
}

/**
 * Reconcile the registry against kinds actually in use. Any kind string
 * found on an annotation but missing from the registry gets registered,
 * so hand-edited annotation files and AI-coined kinds show correct colours.
 */
export function syncKindsFromAnnotations(projectRoot: string, usedKinds: string[]): AnnotationKind[] {
  const kinds = loadKinds(projectRoot)
  const taken = new Set(kinds.map((k) => k.color))
  let changed = false

  for (const name of usedKinds) {
    const trimmed = name.trim()
    if (trimmed.length === 0 || findKind(kinds, trimmed)) continue
    const color = colorForName(trimmed, taken)
    taken.add(color)
    kinds.push({ name: trimmed, color, description: '', createdAt: new Date().toISOString() })
    changed = true
  }

  if (changed) saveKinds(projectRoot, kinds)
  return kinds
}
