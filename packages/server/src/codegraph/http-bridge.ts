/**
 * HTTP Bridge — custom analysis layer that bridges the HTTP boundary.
 *
 * Codegraph cannot follow fetch() calls across the network boundary because
 * the URL is a runtime string. This module scans source files for HTTP client
 * calls (currently fetch()), normalises their URL templates, and matches them
 * against server route nodes to produce synthetic `calls` edges.
 *
 * The synthetic edges are injected into getAllNodesAndEdges() and the per-node
 * incoming/outgoing edge queries so the full call graph is visible.
 *
 * Extension points:
 *   - Add extractAxiosCalls(), extractKyCall(), etc. beside extractFetchCalls()
 *   - Add more mount-path prefixes to the default mountPaths list
 *   - Add pattern handlers in normalizeUrl() for project-specific URL helpers
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Edge, Node } from '@colbymchenry/codegraph'

// ─── Internal types ──────────────────────────────────────────────────────────

interface RawHttpCall {
  /** Relative file path (from project root) */
  filePath: string
  /** 1-indexed line number of the fetch() call */
  line: number
  /** Raw URL template literal content (before normalisation) */
  urlTemplate: string
  /** HTTP method, always uppercase; defaults to 'GET' */
  method: string
}

interface RouteEntry {
  nodeId: string
  method: string
  path: string
  paramCount: number
  segCount: number
  matcher: (path: string) => boolean
}

interface FunctionRange {
  id: string
  startLine: number
  endLine: number
}

// ─── Source scanning ─────────────────────────────────────────────────────────

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'])

/**
 * Extract fetch() calls from TypeScript/JavaScript source text.
 *
 * Handles:
 *   fetch(`${BASE}/api/path`)
 *   fetch(`${BASE}/api/path/${encodeURIComponent(id)}/sub`)
 *   fetch(`${BASE}/api/path`, { method: 'POST', ... })
 *   fetch('/api/path')
 *
 * The parser uses a character-level state machine for template literals so that
 * nested ${...} expressions (e.g., ${encodeURIComponent(x)}) are captured
 * verbatim rather than truncated by a regex character class.
 */
function extractFetchCalls(source: string, relFilePath: string): RawHttpCall[] {
  const calls: RawHttpCall[] = []
  let i = 0

  while (i < source.length) {
    const fi = source.indexOf('fetch(', i)
    if (fi === -1) break

    // Skip if preceded by a word character — avoids matching prefetch(), notFetch(), etc.
    if (fi > 0 && /[a-zA-Z0-9_$]/.test(source[fi - 1]!)) {
      i = fi + 6
      continue
    }

    // 1-indexed line number of the fetch() call
    const line = source.slice(0, fi).split('\n').length

    let j = fi + 6 // advance past 'fetch('

    // Skip whitespace between 'fetch(' and the URL argument
    while (j < source.length && /[ \t\n\r]/.test(source[j]!)) j++

    const startChar = source[j]
    if (startChar !== '`' && startChar !== '"' && startChar !== "'") {
      i = j
      continue
    }

    j++ // skip opening delimiter
    let urlTemplate = ''

    if (startChar === '`') {
      // Template literal — track nested ${...} depth so we handle
      // expressions like ${encodeURIComponent(id)} without truncating them.
      let depth = 0
      while (j < source.length) {
        const ch = source[j]!
        if (ch === '\\' && depth === 0) {
          urlTemplate += source[j + 1] ?? ''
          j += 2
          continue
        }
        if (ch === '$' && source[j + 1] === '{') {
          depth++
          urlTemplate += '${'
          j += 2
          continue
        }
        if (ch === '}' && depth > 0) {
          depth--
          urlTemplate += '}'
          j++
          continue
        }
        if (ch === '`' && depth === 0) {
          j++ // skip closing backtick
          break
        }
        urlTemplate += ch
        j++
      }
    } else {
      // Regular quoted string
      while (j < source.length && source[j] !== startChar) {
        if (source[j] === '\\') {
          urlTemplate += source[j + 1] ?? ''
          j += 2
          continue
        }
        urlTemplate += source[j]!
        j++
      }
      j++ // skip closing quote
    }

    // Scan for a 'method: ...' option in the fetch() options object.
    // Cap the look-ahead at the next fetch( call to avoid bleeding across function
    // boundaries — e.g. a later fetch(url, { method: 'POST' }) would otherwise
    // contaminate the method detection of an earlier fetch(url) call.
    const nextFetch = source.indexOf('fetch(', j)
    const lookAheadEnd = nextFetch !== -1 ? Math.min(j + 512, nextFetch) : j + 512
    const lookAhead = source.slice(j, lookAheadEnd)
    const methodMatch = /method\s*:\s*['"](\w+)['"]/i.exec(lookAhead)
    const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET'

    // Only keep URLs that plausibly represent HTTP paths
    if (urlTemplate.startsWith('/') || urlTemplate.startsWith('${')) {
      calls.push({ filePath: relFilePath, line, urlTemplate, method })
    }

    i = j
  }

  return calls
}

// ─── URL normalisation ───────────────────────────────────────────────────────

/**
 * Normalise a raw URL template string to a plain route path.
 *
 * Transformation steps:
 *   1. Strip the leading base-URL template variable: ${API}, ${BASE_URL}, etc.
 *   2. Strip the API mount-path prefix (e.g. /api, /v1).
 *   3. Replace /${encodeURIComponent(x)} with /:x  (path-segment variables).
 *   4. Replace /${x} with /:x  (other path-segment variables preceded by /).
 *   5. Strip trailing ${expr} NOT preceded by / — these are typically query-string
 *      suffixes (e.g. `…/callgraph${params}` where params = '?depth=3').
 *   6. Replace any remaining ${...} with :param.
 *   7. Strip the query string.
 *   8. Normalise trailing slash.
 *
 * Returns null if the result does not look like a route path.
 */
function normalizeUrl(template: string, mountPaths: string[]): string | null {
  let url = template

  // Step 1 — strip leading base-URL variable
  url = url.replace(/^\$\{[^}]+\}/, '')

  // Step 2 — strip API mount-path prefix
  for (const prefix of mountPaths) {
    if (prefix && (url.startsWith(prefix + '/') || url === prefix)) {
      url = url.slice(prefix.length)
      break
    }
  }

  // Step 3 — ${encodeURIComponent(x)} path segments → :x
  url = url.replace(/\/\$\{encodeURIComponent\((\w+)\)\}/g, '/:$1')

  // Step 4 — other /${varName} path segments → :varName
  url = url.replace(/\/\$\{(\w+)\}/g, '/:$1')

  // Step 5 — trailing ${expr} that is NOT a path segment (no leading /)
  url = url.replace(/\$\{[^}]+\}$/, '')

  // Step 6 — any remaining ${...} in the middle → :param
  url = url.replace(/\$\{[^}]+\}/g, ':param')

  // Step 7 — strip query string
  url = url.replace(/\?.*$/, '')

  // Step 8 — strip trailing slash; keep bare '/'
  url = url.replace(/\/+$/, '') || '/'

  return url.startsWith('/') ? url : null
}

// ─── Route indexing ──────────────────────────────────────────────────────────

/**
 * Build a regex matcher from an Express route path.
 * :param matches exactly one path segment (no slashes).
 * * matches anything.
 */
function makeRouteMatcher(routePath: string): (path: string) => boolean {
  const regexStr = routePath
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
    .replace(/:[a-zA-Z_]\w*/g, '[^/]+') // :param → any segment
    .replace(/\*/g, '.*') // * → anything
  const re = new RegExp(`^${regexStr}$`)
  return (path) => re.test(path)
}

/**
 * Build a sorted route index from graph nodes of kind 'route'.
 *
 * Routes are sorted most-specific first (fewer params, then longer paths).
 * Matching uses first-match-wins, mirroring Express registration order.
 * This ensures `/nodes/search` matches before `/nodes/:nodeId` when both
 * could match the same client path.
 */
function buildRouteIndex(nodes: Node[]): RouteEntry[] {
  const entries: RouteEntry[] = []

  for (const n of nodes) {
    if (n.kind !== 'route') continue
    // Node name format: "METHOD /path"  (e.g. "GET /graph", "POST /projects/open")
    // Skip USE mounts — they are middleware registrations, not callable endpoints.
    const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/.exec(n.name)
    if (!match) continue

    const method = match[1]!
    const path = match[2]!
    entries.push({
      nodeId: n.id,
      method,
      path,
      paramCount: (path.match(/:[a-zA-Z_]\w*/g) ?? []).length,
      segCount: path.split('/').length,
      matcher: makeRouteMatcher(path)
    })
  }

  // Fewer params = more specific = sort first.
  // Equal params: longer path (more segments) = more specific = sort first.
  entries.sort((a, b) => {
    if (a.paramCount !== b.paramCount) return a.paramCount - b.paramCount
    return b.segCount - a.segCount
  })

  return entries
}

/**
 * Find the first route entry whose method and path regex match the given values.
 * Returns the matching route node ID, or null.
 */
function matchRoute(routes: RouteEntry[], method: string, normalizedPath: string): string | null {
  for (const route of routes) {
    if (route.method !== method) continue
    if (route.matcher(normalizedPath)) return route.nodeId
  }
  return null
}

// ─── Containment lookup ──────────────────────────────────────────────────────

/**
 * Build a per-file index of function and method nodes for containment lookup.
 * Keys are file paths relative to the project root.
 */
function buildFunctionIndex(nodes: Node[]): Map<string, FunctionRange[]> {
  const index = new Map<string, FunctionRange[]>()

  for (const n of nodes) {
    if (!['function', 'method'].includes(n.kind)) continue
    if (!n.filePath || n.startLine == null || n.endLine == null) continue

    let list = index.get(n.filePath)
    if (!list) index.set(n.filePath, (list = []))
    list.push({ id: n.id, startLine: n.startLine, endLine: n.endLine })
  }

  return index
}

/**
 * Find the narrowest (most specific) function or method that contains the
 * given line. Returns the node ID, or null if no match.
 */
function findContainingFunction(index: Map<string, FunctionRange[]>, filePath: string, line: number): string | null {
  const ranges = index.get(filePath)
  if (!ranges) return null

  let best: FunctionRange | null = null
  let bestSpan = Infinity

  for (const r of ranges) {
    if (r.startLine <= line && r.endLine >= line) {
      const span = r.endLine - r.startLine
      if (span < bestSpan) {
        bestSpan = span
        best = r
      }
    }
  }

  return best?.id ?? null
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Analyse project source files for HTTP client calls and match them to server
 * route nodes, producing synthetic `calls` edges.
 *
 * @param projectRoot  Absolute path to the project root
 * @param nodes        All graph nodes (for route + function indexes)
 * @param filePaths    Relative file paths to scan (from codegraph's file list)
 * @param mountPaths   API mount-path prefixes to strip from client URLs.
 *                     Tried in order; the first matching prefix wins.
 *                     Default covers the most common patterns.
 */
export async function analyzeHttpBridge(
  projectRoot: string,
  nodes: Node[],
  filePaths: string[],
  mountPaths: string[] = ['/api/v2', '/api/v1', '/api', '/v2', '/v1', '']
): Promise<Edge[]> {
  const routes = buildRouteIndex(nodes)
  if (routes.length === 0) return []

  const functionIndex = buildFunctionIndex(nodes)
  const syntheticEdges: Edge[] = []
  const seen = new Set<string>() // deduplicate (source, target) pairs

  for (const relPath of filePaths) {
    const ext = relPath.slice(relPath.lastIndexOf('.'))
    if (!TS_JS_EXTENSIONS.has(ext)) continue

    let source: string
    try {
      source = await readFile(join(projectRoot, relPath), 'utf-8')
    } catch {
      continue // skip unreadable files silently
    }

    for (const call of extractFetchCalls(source, relPath)) {
      const normalizedPath = normalizeUrl(call.urlTemplate, mountPaths)
      if (!normalizedPath) continue

      const routeNodeId = matchRoute(routes, call.method, normalizedPath)
      if (!routeNodeId) continue

      const callerNodeId = findContainingFunction(functionIndex, call.filePath, call.line)
      if (!callerNodeId) continue

      // Skip self-edges (server calling its own route handler directly — rare
      // but would appear if server-side code also uses fetch())
      if (callerNodeId === routeNodeId) continue

      const key = `${callerNodeId}\x00${routeNodeId}`
      if (seen.has(key)) continue
      seen.add(key)

      syntheticEdges.push({
        source: callerNodeId,
        target: routeNodeId,
        kind: 'calls',
        provenance: 'heuristic',
        metadata: {
          synthetic: true,
          httpMethod: call.method,
          matchedPath: normalizedPath,
          clientFile: call.filePath
        }
      })
    }
  }

  return syntheticEdges
}
