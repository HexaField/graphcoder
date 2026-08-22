import type { FileEntry, GraphSnapshot, NodeDetail, ProjectStats, SearchResultItem, Subgraph } from '@graphcoder/core'

// Derive server URL from the page's own host so the same build works on
// localhost, LAN, and Tailscale without baking in any address.
const API: string = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:3001`

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      message = body.error ?? body.message ?? message
    } catch {
      // ignore parse errors
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function fetchGraph(): Promise<GraphSnapshot> {
  const res = await fetch(`${API}/api/graph`)
  return handleResponse<GraphSnapshot>(res)
}

export async function fetchNodeDetail(nodeId: string): Promise<NodeDetail> {
  const res = await fetch(`${API}/api/nodes/${encodeURIComponent(nodeId)}`)
  return handleResponse<NodeDetail>(res)
}

export async function fetchCallGraph(nodeId: string, depth?: number): Promise<Subgraph> {
  const params = depth !== undefined ? `?depth=${String(depth)}` : ''
  const res = await fetch(`${API}/api/nodes/${encodeURIComponent(nodeId)}/callgraph${params}`)
  return handleResponse<Subgraph>(res)
}

export async function fetchImpactRadius(nodeId: string, depth?: number): Promise<Subgraph> {
  const params = depth !== undefined ? `?depth=${String(depth)}` : ''
  const res = await fetch(`${API}/api/nodes/${encodeURIComponent(nodeId)}/impact${params}`)
  return handleResponse<Subgraph>(res)
}

export async function searchNodes(q: string): Promise<{ results: SearchResultItem[] }> {
  const res = await fetch(`${API}/api/nodes/search?q=${encodeURIComponent(q)}`)
  return handleResponse<{ results: SearchResultItem[] }>(res)
}

export async function openProject(
  projectRoot: string
): Promise<{ success: boolean; projectRoot: string; stats: ProjectStats }> {
  const res = await fetch(`${API}/api/projects/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot })
  })
  return handleResponse<{ success: boolean; projectRoot: string; stats: ProjectStats }>(res)
}

export async function fetchCurrentProject(): Promise<{
  open: boolean
  projectRoot?: string
  stats?: ProjectStats
}> {
  const res = await fetch(`${API}/api/projects/current`)
  return handleResponse<{ open: boolean; projectRoot?: string; stats?: ProjectStats }>(res)
}

export async function fetchFiles(): Promise<{ files: FileEntry[] }> {
  const res = await fetch(`${API}/api/files`)
  return handleResponse<{ files: FileEntry[] }>(res)
}
