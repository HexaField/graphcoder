/**
 * `graphcoder digest [path] [--json]`
 *
 * Render all annotations as structured text, grouped by kind, with
 * freshness status. The digest stays computed — it reads the annotation
 * files + the CodeGraph index and produces human-readable output. Nothing
 * gets written to disk.
 */
import chalk from 'chalk'
import { loadAllAnnotations, findStaleAnnotations, loadKinds } from '@graphcoder/core/annotations/server'
import { nodeSemanticId } from '@graphcoder/core'
import type { Annotation, AnnotationKind } from '@graphcoder/core'
import type { Node } from '@colbymchenry/codegraph'
import { CodeGraph, NODE_KINDS } from '../codegraph-shim.js'
import { findProjectRoot } from '../utils/project.js'

export interface DigestOptions {
  json?: boolean
}

interface DigestJson {
  projectRoot: string
  kinds: AnnotationKind[]
  groups: Array<{
    kind: string
    annotations: Array<{
      id: string
      shape: string
      label: string
      description: string
      memberNames: string[]
      unresolvedCount: number
      status: string
    }>
  }>
  stats: { total: number; stale: number; proposed: number; active: number }
}

export async function digestCommand(targetPath: string, options: DigestOptions): Promise<void> {
  const projectRoot = findProjectRoot(targetPath)
  if (!projectRoot) {
    console.error(chalk.red('No .graphcoder directory found — not a GraphCoder project'))
    process.exit(2)
  }

  const annotations = loadAllAnnotations(projectRoot)
  const kinds = loadKinds(projectRoot)

  // Try to open CodeGraph for name resolution (optional — digest works without it)
  const nodeBySemId = new Map<string, Node>()
  let hasCodeGraph = false
  try {
    if (CodeGraph.isInitialized(projectRoot)) {
      const cg = await CodeGraph.open(projectRoot)
      const seenIds = new Set<string>()
      for (const kind of NODE_KINDS) {
        for (const node of cg.getNodesByKind(kind)) {
          if (!seenIds.has(node.id)) {
            seenIds.add(node.id)
            nodeBySemId.set(nodeSemanticId(node), node)
          }
        }
      }
      hasCodeGraph = true
    }
  } catch {
    // CodeGraph unavailable — degrade gracefully
  }

  const knownIds = new Set(nodeBySemId.keys())
  const staleMap = hasCodeGraph ? findStaleAnnotations(annotations, knownIds) : new Map()

  // Group by kind
  const groups = new Map<string, Annotation[]>()
  for (const ann of annotations) {
    const key = ann.kind || ''
    const group = groups.get(key) ?? []
    group.push(ann)
    groups.set(key, group)
  }

  // Sort: registry kinds first (in registry order), then unregistered, then unkinded last
  const kindOrder = new Map(kinds.map((k, i) => [k.name.toLowerCase(), i]))
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    const aIdx = kindOrder.get(a.toLowerCase()) ?? Infinity
    const bIdx = kindOrder.get(b.toLowerCase()) ?? Infinity
    if (aIdx !== bIdx) return aIdx - bIdx
    return a.localeCompare(b)
  })

  // Stats
  const stats = { total: annotations.length, stale: 0, proposed: 0, active: 0 }
  for (const ann of annotations) {
    if (staleMap.has(ann.id)) stats.stale++
    else if (ann.status === 'proposed') stats.proposed++
    else stats.active++
  }

  // ── JSON output ────────────────────────────────────────────────────────────
  if (options.json) {
    const result: DigestJson = {
      projectRoot,
      kinds,
      groups: sortedKeys.map((key) => ({
        kind: key || '(unkinded)',
        annotations: (groups.get(key) ?? []).map((ann) => {
          const staleResult = staleMap.get(ann.id)
          const memberNames = ann.members.map((sid) => nodeBySemId.get(sid)?.name).filter((n): n is string => n != null)
          return {
            id: ann.id,
            shape: ann.shape,
            label: ann.label,
            description: ann.description,
            memberNames,
            unresolvedCount: staleResult?.unresolved.length ?? 0,
            status: staleResult ? 'stale' : ann.status
          }
        })
      })),
      stats
    }
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ── Text output ────────────────────────────────────────────────────────────
  if (annotations.length === 0) {
    console.log(chalk.yellow('No annotations.'))
    return
  }

  for (const key of sortedKeys) {
    const group = groups.get(key)!
    const displayKind = key || '(unkinded)'
    console.log(`\n${chalk.bold(`# ${displayKind}`)} (${group.length})`)

    for (const ann of group) {
      console.log()
      const staleResult = staleMap.get(ann.id)

      // Shape + label line
      console.log(`${ann.shape} ${chalk.cyan(`"${ann.label}"`)}`)

      // Description
      if (ann.description) {
        console.log(`  ${ann.description}`)
      }

      // Members
      const memberNames = ann.members.map((sid) => nodeBySemId.get(sid)?.name).filter((n): n is string => n != null)

      if (memberNames.length > 0) {
        const prefix = ann.shape === 'polyline' ? 'Path' : 'Members'
        console.log(`  ${prefix}: ${memberNames.join(', ')}`)
      } else if (ann.members.length > 0 && !hasCodeGraph) {
        console.log(`  Members: ${ann.members.length} (CodeGraph not available for name resolution)`)
      } else if (ann.members.length > 0) {
        console.log(`  Members: ${ann.members.length} unresolved`)
      }

      // Status
      if (staleResult) {
        console.log(`  Status: ${chalk.yellow('stale')} (${staleResult.unresolved.length} unresolved)`)
      } else if (ann.status === 'proposed') {
        console.log(`  Status: ${chalk.blue('proposed')}`)
      } else {
        console.log(`  Status: ${chalk.green('current')}`)
      }
    }
  }

  // Summary
  console.log()
  const parts = [`${stats.total} annotations`]
  if (stats.stale > 0) parts.push(chalk.yellow(`${stats.stale} stale`))
  if (stats.proposed > 0) parts.push(chalk.blue(`${stats.proposed} proposed`))
  console.log(parts.join(', '))
}
