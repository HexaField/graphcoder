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

export function nodeSemanticId(node: Pick<GraphNode, 'kind' | 'name' | 'signature'>): string {
  return semanticId(node.kind, node.name, node.signature)
}
