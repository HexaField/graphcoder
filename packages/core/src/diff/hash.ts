import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { GraphSnapshot } from '../index.js'
import { nodeSemanticId } from '../identity.js'
import type { ArchDiff } from './types.js'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
  return `{${pairs.join(',')}}`
}

const enc = new TextEncoder()

export function snapshotHash(snapshot: GraphSnapshot): string {
  const nodes = [...snapshot.nodes]
    .sort((a, b) => nodeSemanticId(a).localeCompare(nodeSemanticId(b)))
    .map((n) => ({
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      filePath: n.filePath,
      language: n.language,
      signature: n.signature,
      visibility: n.visibility,
      isExported: n.isExported,
      isAsync: n.isAsync,
      isStatic: n.isStatic,
      isAbstract: n.isAbstract,
      returnType: n.returnType
    }))
  const edges = [...snapshot.edges]
    .sort((a, b) => `${a.source}|${a.target}|${a.kind}`.localeCompare(`${b.source}|${b.target}|${b.kind}`))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
  return bytesToHex(sha256(enc.encode(canonicalJson({ nodes, edges }))))
}

export function computeDiffHash(diff: Omit<ArchDiff, 'diffHash'>): string {
  return bytesToHex(sha256(enc.encode(canonicalJson(diff))))
}
