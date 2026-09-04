/**
 * Provider discovery — probes local endpoints and CLI tools to find
 * available AI backends. Returns a sorted list ready for the client UI.
 */
import { execFile } from 'node:child_process'
import type { ProviderConfig } from './types.js'

export interface DiscoveredProvider {
  id: string
  label: string
  type: 'openai-compat' | 'cli' | 'test'
  config: ProviderConfig
  model?: string
}

// ── Endpoint probes ──────────────────────────────────────────────────────────

interface ProbeSpec {
  port: number
  path: string
  kind: 'openai' | 'ollama'
  label: string
}

const PROBES: ProbeSpec[] = [
  { port: 9090, path: '/v1/models', kind: 'openai', label: 'llama-server' },
  { port: 8080, path: '/v1/models', kind: 'openai', label: 'llama-server' },
  { port: 11434, path: '/api/tags', kind: 'ollama', label: 'Ollama' }
]

/** Probe a single HTTP endpoint with a short timeout. */
async function probeEndpoint(spec: ProbeSpec): Promise<DiscoveredProvider | null> {
  const url = `http://localhost:${spec.port}${spec.path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null

    const data = (await res.json()) as Record<string, unknown>
    let modelName: string | undefined

    if (spec.kind === 'ollama') {
      const models = data.models as Array<{ name: string }> | undefined
      modelName = models?.[0]?.name
    } else {
      const models = data.data as Array<{ id: string }> | undefined
      modelName = models?.[0]?.id
    }

    if (!modelName) return null

    // Ollama exposes OpenAI-compat at /v1; llama-server natively at /v1
    const endpoint = spec.kind === 'ollama' ? `http://localhost:${spec.port}/v1` : `http://localhost:${spec.port}/v1`

    const config: ProviderConfig = {
      type: 'openai-compat',
      endpoint,
      model: modelName
    }

    // Shorten model name for display — strip path prefixes, .gguf extension, long hashes
    const shortModel = modelName
      .replace(/^.*\//, '')
      .replace(/\.gguf$/i, '')
      .replace(/-[0-9a-f]{12,}$/, '')

    return {
      id: `${spec.label.toLowerCase().replace(/\s+/g, '-')}-${spec.port}`,
      label: `${spec.label} :${spec.port} — ${shortModel}`,
      type: 'openai-compat',
      config,
      model: modelName
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── CLI probes ───────────────────────────────────────────────────────────────

/** Check whether a CLI command exists on PATH. */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err))
  })
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover available AI providers by probing local endpoints and CLI tools.
 * All probes run in parallel. Returns providers sorted: local LLM → CLI → test.
 */
export async function discoverProviders(): Promise<DiscoveredProvider[]> {
  const results: DiscoveredProvider[] = []

  // Run all probes concurrently
  const [endpointResults, hasClaude] = await Promise.all([
    Promise.all(PROBES.map(probeEndpoint)),
    commandExists('claude')
  ])

  // Collect endpoint hits
  for (const provider of endpointResults) {
    if (provider) results.push(provider)
  }

  // CLI providers
  if (hasClaude) {
    results.push({
      id: 'claude-cli',
      label: 'Claude CLI',
      type: 'cli',
      config: { command: 'claude', args: ['--print'], sessionResume: true }
    })
  }

  // Test provider — always last
  results.push({
    id: 'test',
    label: 'Test (deterministic)',
    type: 'test',
    config: { type: 'test' }
  })

  // Sort: openai-compat first, cli second, test last
  const order: Record<string, number> = { 'openai-compat': 1, cli: 2, test: 3 }
  results.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))

  return results
}
