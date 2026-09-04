/**
 * Provider factory — loads config and instantiates the correct AI provider.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AIProvider, ProviderConfig } from './types.js'
import { CLIProvider } from './cli.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { TestProvider } from './test.js'

/** Resolved provider config from .graphcoder/config.json */
export interface AIConfig {
  defaultProvider: string
  providers: Record<string, ProviderConfig>
}

/** Instantiate a provider from its config. */
export function getProvider(name: string, config: ProviderConfig): AIProvider {
  if ('type' in config && config.type === 'test') return new TestProvider()
  if (name === 'test') return new TestProvider()

  if ('type' in config && config.type === 'openai-compat') {
    return new OpenAICompatProvider(config)
  }

  // Default: CLI provider (type is 'cli' or undefined).
  if ('command' in config) {
    return new CLIProvider(config)
  }

  throw new Error(`Unknown provider config for '${name}': ${JSON.stringify(config)}`)
}

/** Load AI provider config from .graphcoder/config.json. Falls back to test provider. */
export function loadProviderConfig(projectRoot: string): AIConfig {
  const configPath = join(projectRoot, '.graphcoder', 'config.json')

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const json = JSON.parse(raw) as Record<string, unknown>
      if (json.ai && typeof json.ai === 'object') {
        const ai = json.ai as AIConfig
        if (ai.defaultProvider && ai.providers) return ai
      }
    } catch (err) {
      console.warn(`[GraphCoder] Failed to load provider config: ${err}`)
    }
  }

  // Fall back to test provider.
  return {
    defaultProvider: 'test',
    providers: { test: { type: 'test' } }
  }
}
