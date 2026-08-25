import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { GraphNode } from './index.js'

/**
 * Strip default parameter values and collapse whitespace.
 */
export function normalizeSignature(sig: string): string {
  return sig
    .replace(/\s*=\s*[^,)[\]{}]+(?=[,)\]])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Deterministic, file-path-independent semantic identity for a graph node.
 */
const enc = new TextEncoder()

export function semanticId(kind: string, name: string, signature?: string): string {
  const sig = signature ? normalizeSignature(signature) : ''
  return bytesToHex(sha256(enc.encode(`${kind}\0${name}\0${sig}`)))
}

export function nodeSemanticId(node: Pick<GraphNode, 'kind' | 'name' | 'signature' | 'filePath'>): string {
  // File and module nodes represent unique filesystem paths — two files
  // named `index.ts` in different directories are distinct entities.
  // Include filePath so they don't collide during diff deduplication.
  if (node.kind === 'file' || node.kind === 'module') {
    return semanticId(node.kind, node.filePath ?? node.name, node.signature)
  }
  return semanticId(node.kind, node.name, node.signature)
}

/**
 * Build a reverse map from semantic IDs back to CodeGraph IDs.
 *
 * During a temporal diff the canvas remaps node IDs to semantic IDs so the
 * diff overlay can match nodes across commits. This function builds the
 * inverse (semantic → CodeGraph ID) so REST calls can resolve back to the
 * server's native IDs.
 *
 * Target IDs overwrite base IDs — the target snapshot represents the
 * current codebase, so its CodeGraph IDs take priority. Base IDs serve
 * as fallback for removed nodes.
 *
 * @returns Map<semanticId, codeGraphId>
 */
export function buildDiffIdMap(
  baseNodes: Pick<GraphNode, 'id' | 'kind' | 'name' | 'signature' | 'filePath'>[],
  targetNodes: Pick<GraphNode, 'id' | 'kind' | 'name' | 'signature' | 'filePath'>[]
): Map<string, string> {
  const map = new Map<string, string>()
  for (const n of baseNodes) map.set(nodeSemanticId(n), n.id)
  for (const n of targetNodes) map.set(nodeSemanticId(n), n.id) // target wins
  return map
}
