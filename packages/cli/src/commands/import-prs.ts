/**
 * `graphcoder import-prs [path] --base <ref> --tip <ref>`
 *
 * Import a stacked PR chain as proposed region annotations. Each PR
 * becomes one annotation whose members cover the graph nodes in the
 * files that PR changed.
 *
 * Strategy: open CodeGraph at the current checkout (which should be the
 * stack tip) and use `git diff --name-only parent..branch` per PR to
 * find changed files. Map changed files to graph nodes via CodeGraph's
 * file index. This avoids O(branches × repo_size) worktree generation.
 */
import chalk from 'chalk'
import simpleGit from 'simple-git'
import { createAnnotation, saveAnnotation, ensureKind, loadAllAnnotations } from '@graphcoder/core/annotations/server'
import { nodeSemanticId } from '@graphcoder/core'
import type { Node } from '@colbymchenry/codegraph'
import { CodeGraph, NODE_KINDS } from '../codegraph-shim.js'
import { findProjectRoot } from '../utils/project.js'

export interface ImportPrsOptions {
  base: string
  tip: string
}

interface PrSlice {
  index: number
  hash: string
  message: string
  files: string[]
}

export async function importPrsCommand(targetPath: string, options: ImportPrsOptions): Promise<void> {
  const projectRoot = findProjectRoot(targetPath)
  if (!projectRoot) {
    console.error(chalk.red('No .graphcoder directory found — not a GraphCoder project'))
    process.exit(2)
  }

  const { base, tip } = options
  if (!base || !tip) {
    console.error(chalk.red('Both --base and --tip are required'))
    process.exit(2)
  }

  // ── Discover the PR stack via git ──────────────────────────────────────────
  const git = simpleGit(projectRoot)

  // Get commits between base and tip (oldest first)
  const logResult = await git.log({ from: base, to: tip })
  const commits = [...logResult.all].reverse() // oldest first

  if (commits.length === 0) {
    console.log(chalk.yellow(`No commits between ${base} and ${tip}`))
    process.exit(0)
  }

  // Build PR slices: each commit becomes one PR entry, with its changed files
  const slices: PrSlice[] = []
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    const parentRef = i === 0 ? base : commits[i - 1].hash
    const diffSummary = await git.diffSummary([`${parentRef}..${commit.hash}`])
    const files = diffSummary.files.map((f) => f.file)

    slices.push({
      index: i + 1,
      hash: commit.hash,
      message: commit.message,
      files
    })
  }

  // ── Open CodeGraph at the current checkout ──────────────────────────────────
  if (!CodeGraph.isInitialized(projectRoot)) {
    console.error(chalk.red('CodeGraph not initialized — run `codegraph init`'))
    process.exit(2)
  }
  const cg = await CodeGraph.open(projectRoot)

  // Build file → nodes map
  const nodesByFile = new Map<string, Node[]>()
  const seenIds = new Set<string>()
  for (const kind of NODE_KINDS) {
    for (const node of cg.getNodesByKind(kind)) {
      if (seenIds.has(node.id)) continue
      seenIds.add(node.id)
      const fp = node.filePath
      if (!fp) continue
      const list = nodesByFile.get(fp) ?? []
      list.push(node)
      nodesByFile.set(fp, list)
    }
  }

  // ── Check for existing PR annotations to avoid duplicates ──────────────────
  const existing = loadAllAnnotations(projectRoot)
  const existingLabels = new Set(existing.map((a) => a.label))

  // ── Create annotations ─────────────────────────────────────────────────────
  // Register the 'pr' kind
  ensureKind(projectRoot, 'pr')

  let created = 0
  for (const slice of slices) {
    // Derive label from commit message (strip conventional-commit prefix for display)
    const label = `PR${slice.index}: ${slice.message}`
    if (existingLabels.has(label)) {
      console.log(chalk.yellow(`  skip: "${label}" (already exists)`))
      continue
    }

    // Collect semantic IDs of nodes in changed files
    const memberIds: string[] = []
    const memberIdSet = new Set<string>()
    for (const file of slice.files) {
      // Try both the raw path and common prefixes
      const nodes = nodesByFile.get(file) ?? []
      for (const node of nodes) {
        const sid = nodeSemanticId(node)
        if (!memberIdSet.has(sid)) {
          memberIdSet.add(sid)
          memberIds.push(sid)
        }
      }
    }

    if (memberIds.length === 0) {
      console.log(chalk.dim(`  skip: PR${slice.index} "${slice.message}" — no graph nodes in changed files`))
      continue
    }

    const annotation = createAnnotation('region', label, memberIds, {
      kind: 'pr',
      description: `Commit ${slice.hash.slice(0, 8)}: ${slice.message}`,
      status: 'proposed',
      author: 'agent'
    })

    saveAnnotation(projectRoot, annotation)
    created++
    console.log(chalk.green(`  ✓ PR${slice.index}:`) + ` "${slice.message}" (${memberIds.length} members)`)
  }

  console.log()
  if (created > 0) {
    console.log(chalk.green(`Imported ${created} PR annotations as proposed.`))
    console.log(chalk.dim('Review them in the GraphCoder UI or run `graphcoder digest`.'))
  } else {
    console.log(chalk.yellow('No new annotations created (all PRs already imported or empty).'))
  }
}
