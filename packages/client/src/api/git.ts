/**
 * Typed fetch wrappers for the Git REST API.
 *
 * `computeDiff` uses SSE (fetch + ReadableStream) so the caller can receive
 * granular progress messages while snapshot indexing runs on the server.
 */
import type { ArchDiff, GraphSnapshot } from '@graphcoder/core'

const API: string = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:3001`

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
}

export interface GitStatus {
  isGitRepo: boolean
  currentBranch: string | null
  repoRoot: string | null
}

export async function fetchGitStatus(): Promise<GitStatus> {
  const res = await fetch(`${API}/api/git/status`)
  if (!res.ok) throw new Error(`GET /git/status ${res.status}`)
  return res.json() as Promise<GitStatus>
}

export async function fetchBranches(): Promise<{ branches: string[]; current: string | null }> {
  const res = await fetch(`${API}/api/git/branches`)
  if (!res.ok) throw new Error(`GET /git/branches ${res.status}`)
  return res.json() as Promise<{ branches: string[]; current: string | null }>
}

export async function fetchCommits(branch?: string, limit = 50): Promise<CommitInfo[]> {
  const params = new URLSearchParams()
  if (branch) params.set('branch', branch)
  params.set('limit', String(limit))
  const res = await fetch(`${API}/api/git/commits?${params}`)
  if (!res.ok) throw new Error(`GET /git/commits ${res.status}`)
  const body = (await res.json()) as { commits: CommitInfo[] }
  return body.commits
}

// ── Git graph ────────────────────────────────────────────────────────────────

export interface GraphCommit {
  hash: string
  shortHash: string
  parents: string[]
  message: string
  author: string
  date: string
}

export interface BranchRef {
  name: string
  hash: string
  current: boolean
}

export interface GitGraph {
  commits: GraphCommit[]
  branches: BranchRef[]
}

export async function fetchGitGraph(limit = 200): Promise<GitGraph> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  const res = await fetch(`${API}/api/git/graph?${params}`)
  if (!res.ok) throw new Error(`GET /git/graph ${res.status}`)
  return res.json() as Promise<GitGraph>
}

/** Result from the diff SSE stream — includes both snapshots for the diff view. */
export interface DiffResult {
  diff: ArchDiff
  baseSnapshot: GraphSnapshot
  targetSnapshot: GraphSnapshot
}

/**
 * Stream a diff computation from the server via SSE.
 *
 * Calls `onProgress` for each `progress` event, and resolves with the final
 * `DiffResult` when the `result` event arrives. Rejects on `error` events or
 * network failures.
 */
export async function computeDiff(
  base: string,
  target: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<DiffResult> {
  return new Promise<DiffResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }

    fetch(`${API}/api/git/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ base, target }),
      signal
    })
      .then(async (response) => {
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string }
          reject(new Error(err.error ?? `HTTP ${response.status}`))
          return
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        const flush = () => {
          const blocks = buffer.split('\n\n')
          // Keep the incomplete last block in the buffer.
          buffer = blocks.pop() ?? ''

          for (const block of blocks) {
            let eventName = ''
            let dataStr = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) {
                eventName = line.slice(7).trim()
              } else if (line.startsWith('data: ')) {
                dataStr = line.slice(6)
              }
            }
            if (!eventName || !dataStr) continue
            try {
              const data = JSON.parse(dataStr)
              if (eventName === 'progress') {
                onProgress?.((data as { message: string }).message)
              } else if (eventName === 'result') {
                resolve(data as DiffResult)
              } else if (eventName === 'error') {
                reject(new Error((data as { error: string }).error))
              }
            } catch {
              // ignore malformed events
            }
          }
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            flush()
          }
          flush()
        } catch (streamErr) {
          reject(streamErr)
        }
      })
      .catch(reject)
  })
}
