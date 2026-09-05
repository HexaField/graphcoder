import chalk from 'chalk'
import { loadAllAnnotations, findStaleAnnotations } from '@graphcoder/core/annotations/server'
import { nodeSemanticId } from '@graphcoder/core'
import type { Node } from '@colbymchenry/codegraph'
import { CodeGraph, NODE_KINDS } from '../codegraph-shim.js'
import { findProjectRoot } from '../utils/project.js'

interface Candidate {
  name: string
  qualifiedName: string
  filePath: string
  reason: string
}

/** Search all graph nodes for a plausible rename candidate. */
function findCandidate(
  _semanticId: string,
  _allNodes: Node[],
  _resolvedIds: Set<string>,
  _nodeBySemId: Map<string, Node>
): Candidate | null {
  // Stub — the full rename-detection pipeline belongs to
  // the resolution-hints work (Phase 3c item 2 in the plan).
  return null
}

export async function checkCommand(targetPath: string): Promise<void> {
  const projectRoot = findProjectRoot(targetPath)
  if (!projectRoot) {
    console.error(chalk.red('No .graphcoder directory found — not a GraphCoder project'))
    process.exit(2)
  }

  // Load annotations
  const annotations = loadAllAnnotations(projectRoot)
  if (annotations.length === 0) {
    console.log(chalk.yellow('No annotations found.'))
    process.exit(0)
  }

  // Open CodeGraph
  if (!CodeGraph.isInitialized(projectRoot)) {
    console.error(chalk.red('CodeGraph not initialized — run `codegraph init`'))
    process.exit(2)
  }

  const cg = await CodeGraph.open(projectRoot)

  // Extract all nodes and build semantic ID map
  const allNodes: Node[] = []
  const seenIds = new Set<string>()
  for (const kind of NODE_KINDS) {
    for (const node of cg.getNodesByKind(kind)) {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id)
        allNodes.push(node)
      }
    }
  }

  const nodeBySemId = new Map<string, Node>()
  for (const node of allNodes) {
    nodeBySemId.set(nodeSemanticId(node), node)
  }
  const knownIds = new Set(nodeBySemId.keys())

  // Check each annotation
  const staleMap = findStaleAnnotations(annotations, knownIds)

  let staleCount = 0
  for (const ann of annotations) {
    const result = staleMap.get(ann.id)
    if (!result || result.unresolved.length === 0) {
      // All members resolve
      const kindLabel = ann.kind ? ` [${ann.kind}]` : ''
      console.log(
        chalk.green('✓') + ` ${ann.shape} "${ann.label}"${kindLabel} — all ${ann.members.length} members resolve`
      )
      continue
    }

    staleCount++
    const resolvedCount = result.resolved.length
    const totalCount = ann.members.length
    const kindLabel = ann.kind ? ` [${ann.kind}]` : ''
    console.log(
      chalk.yellow('⚠') + ` ${ann.shape} "${ann.label}"${kindLabel} — ${resolvedCount}/${totalCount} resolved`
    )

    for (const unresolvedId of result.unresolved) {
      const shortId = unresolvedId.slice(0, 12) + '…'
      console.log(`  ${chalk.red('✗')} member ${shortId} not found`)

      const candidate = findCandidate(unresolvedId, allNodes, knownIds, nodeBySemId)
      if (candidate) {
        console.log(`    ${chalk.cyan('candidate:')} ${candidate.name} (${candidate.filePath}) [${candidate.reason}]`)
      }
    }
  }

  // Summary
  console.log()
  if (staleCount > 0) {
    console.log(chalk.yellow(`${annotations.length} annotations checked, ${staleCount} stale`))
    process.exit(1)
  } else {
    console.log(chalk.green(`${annotations.length} annotations checked, all current`))
    process.exit(0)
  }
}
