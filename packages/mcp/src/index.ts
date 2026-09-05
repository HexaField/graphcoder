#!/usr/bin/env node
/**
 * GraphCoder MCP server — exposes annotation check, digest, and PR-stack
 * import as MCP tools so AI agents can call them directly.
 *
 * Transport: stdio (the standard for CLI-launched MCP servers).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { nodeSemanticId } from '@graphcoder/core'
import {
  loadAllAnnotations,
  findStaleAnnotations,
  loadKinds,
  createAnnotation,
  saveAnnotation,
  ensureKind
} from '@graphcoder/core/annotations/server'
import simpleGit from 'simple-git'
import { CodeGraph, NODE_KINDS } from './codegraph-shim.js'
import type { Node } from '@colbymchenry/codegraph'

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'graphcoder',
  version: '1.0.0'
})

// ── Tool: graphcoder_check ──────────────────────────────────────────────────

server.tool(
  'graphcoder_check',
  'Check annotation health — reports which annotations have unresolvable member references',
  { projectRoot: z.string().describe('Absolute path to the project root (must contain .graphcoder/)') },
  async ({ projectRoot }) => {
    const annotations = loadAllAnnotations(projectRoot)
    if (annotations.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ annotations: 0, stale: 0, results: [] }) }] }
    }

    if (!CodeGraph.isInitialized(projectRoot)) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'CodeGraph not initialized — run codegraph init' }) }
        ],
        isError: true
      }
    }

    const cg = await CodeGraph.open(projectRoot)
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
    const staleMap = findStaleAnnotations(annotations, knownIds)

    const results = annotations.map((ann) => {
      const result = staleMap.get(ann.id)
      return {
        id: ann.id,
        label: ann.label,
        kind: ann.kind,
        shape: ann.shape,
        totalMembers: ann.members.length,
        resolved: result?.resolved.length ?? ann.members.length,
        unresolved: result?.unresolved ?? []
      }
    })

    const staleCount = results.filter((r) => r.unresolved.length > 0).length
    const text = JSON.stringify({ annotations: annotations.length, stale: staleCount, results }, null, 2)
    return { content: [{ type: 'text' as const, text }] }
  }
)

// ── Tool: graphcoder_digest ─────────────────────────────────────────────────

server.tool(
  'graphcoder_digest',
  'Produce a structured digest of all annotations, grouped by kind, with resolved member names',
  { projectRoot: z.string().describe('Absolute path to the project root') },
  async ({ projectRoot }) => {
    const annotations = loadAllAnnotations(projectRoot)
    const kinds = loadKinds(projectRoot)

    let nodeBySemId: Map<string, Node> | null = null
    if (CodeGraph.isInitialized(projectRoot)) {
      const cg = await CodeGraph.open(projectRoot)
      nodeBySemId = new Map()
      const seenIds = new Set<string>()
      for (const kind of NODE_KINDS) {
        for (const node of cg.getNodesByKind(kind)) {
          if (!seenIds.has(node.id)) {
            seenIds.add(node.id)
            nodeBySemId.set(nodeSemanticId(node), node)
          }
        }
      }
    }

    // Group by kind
    const byKind = new Map<string, typeof annotations>()
    for (const ann of annotations) {
      const key = ann.kind || '(unkinded)'
      const list = byKind.get(key) ?? []
      list.push(ann)
      byKind.set(key, list)
    }

    const digest = [...byKind.entries()].map(([kind, anns]) => ({
      kind,
      color: kinds.find((k) => k.name === kind)?.color ?? null,
      count: anns.length,
      annotations: anns.map((a) => ({
        id: a.id,
        label: a.label,
        shape: a.shape,
        status: a.status,
        description: a.description,
        memberCount: a.members.length,
        members: a.members.map((sid) => {
          const node = nodeBySemId?.get(sid)
          return node
            ? { semanticId: sid, name: node.name, kind: node.kind, file: node.filePath }
            : { semanticId: sid, name: null, kind: null, file: null }
        })
      }))
    }))

    const text = JSON.stringify({ kinds: kinds.length, annotations: annotations.length, digest }, null, 2)
    return { content: [{ type: 'text' as const, text }] }
  }
)

// ── Tool: graphcoder_import_prs ─────────────────────────────────────────────

server.tool(
  'graphcoder_import_prs',
  'Import a stacked PR chain as proposed annotations. Each PR becomes a region annotation with kind=pr.',
  {
    projectRoot: z.string().describe('Absolute path to the project root'),
    base: z.string().describe('Base git ref (branch or commit hash)'),
    tip: z.string().describe('Tip git ref (branch or commit hash)')
  },
  async ({ projectRoot, base, tip }) => {
    if (!CodeGraph.isInitialized(projectRoot)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CodeGraph not initialized' }) }],
        isError: true
      }
    }

    const git = simpleGit(projectRoot)
    const log = await git.log({ from: base, to: tip })
    const commits = log.all

    if (commits.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `No commits between ${base} and ${tip}` }) }],
        isError: true
      }
    }

    // Build file → semantic ID map
    const cg = await CodeGraph.open(projectRoot)
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

    // Register the 'pr' kind
    ensureKind(projectRoot, 'pr')

    // Check existing annotations to avoid duplicates
    const existing = loadAllAnnotations(projectRoot)
    const existingLabels = new Set(existing.map((a) => a.label))

    const created: Array<{ label: string; members: number }> = []
    const reversed = [...commits].reverse()

    for (let i = 0; i < reversed.length; i++) {
      const commit = reversed[i]
      const title = commit.message.split('\n')[0]
      const label = `PR${i + 1}: ${title}`
      if (existingLabels.has(label)) continue

      // Get files changed in this commit
      const diff = await git.diffSummary([`${commit.hash}~1`, commit.hash])
      const files = diff.files.map((f) => f.file)

      const memberIds: string[] = []
      const seen = new Set<string>()
      for (const file of files) {
        for (const node of nodesByFile.get(file) ?? []) {
          const sid = nodeSemanticId(node)
          if (!seen.has(sid)) {
            seen.add(sid)
            memberIds.push(sid)
          }
        }
      }

      if (memberIds.length === 0) continue

      const annotation = createAnnotation('region', label, memberIds, {
        kind: 'pr',
        description: `Commit ${commit.hash.slice(0, 8)}: ${title}`,
        status: 'proposed',
        author: 'agent'
      })
      saveAnnotation(projectRoot, annotation)
      created.push({ label, members: memberIds.length })
    }

    const text = JSON.stringify({ created: created.length, annotations: created }, null, 2)
    return { content: [{ type: 'text' as const, text }] }
  }
)

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('graphcoder-mcp fatal:', err)
  process.exit(1)
})
