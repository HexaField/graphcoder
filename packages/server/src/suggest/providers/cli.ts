/**
 * CLI provider — spawns an external AI CLI (Claude, Codex, etc.) and
 * parses structured JSON from its stdout.
 */
import { spawn } from 'node:child_process'
import type { AIProvider, SuggestRequest, SuggestResult, RefineRequest } from './types.js'
import type { AISuggestResponse } from '@graphcoder/core'

export interface CLIProviderConfig {
  command: string
  args: string[]
  sessionResume: boolean
}

/** Extract the first complete JSON object from a string. */
function extractJson(text: string): AISuggestResponse | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(text.substring(start, end + 1)) as AISuggestResponse
  } catch {
    return null
  }
}

export class CLIProvider implements AIProvider {
  name: string
  config: CLIProviderConfig

  constructor(config: CLIProviderConfig) {
    this.config = config
    this.name = config.command
  }

  async suggest(req: SuggestRequest): Promise<SuggestResult> {
    const input = [req.systemPrompt, '', '## Context', req.context, '', '## User Request', req.userPrompt].join('\n')
    return this.run(input, [])
  }

  async refine(req: RefineRequest): Promise<SuggestResult> {
    const extraArgs = req.sessionId && this.config.sessionResume ? ['--resume', req.sessionId] : []

    const input = [
      req.systemPrompt,
      '',
      '## Current Annotation State',
      req.currentAnnotation,
      '',
      '## User Refinement',
      req.userMessage
    ].join('\n')

    return this.run(input, extraArgs)
  }

  private run(input: string, extraArgs: string[]): Promise<SuggestResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command, [...this.config.args, ...extraArgs], {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn '${this.config.command}': ${err.message}`))
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`'${this.config.command}' exited with code ${code}: ${stderr}`))
          return
        }
        resolve({
          raw: stdout,
          parsed: extractJson(stdout),
          sessionId: null
        })
      })

      child.stdin.write(input)
      child.stdin.end()
    })
  }
}
