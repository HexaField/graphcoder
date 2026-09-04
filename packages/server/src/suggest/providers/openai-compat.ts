/**
 * OpenAI-compatible API provider — calls any /v1/chat/completions endpoint.
 * Supports local LLMs, hosted endpoints, anything behind the OpenAI schema.
 */
import type { AIProvider, SuggestRequest, SuggestResult, RefineRequest } from './types.js'
import type { AISuggestResponse } from '@graphcoder/core'

export interface OpenAICompatConfig {
  endpoint: string
  model: string
  apiKey?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface CompletionResponse {
  choices: Array<{ message: { content: string } }>
}

/** Extract JSON from text that might contain markdown code fences. */
function extractJson(text: string): AISuggestResponse | null {
  // Try stripping markdown fences first.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const candidate = fenceMatch ? fenceMatch[1]! : text

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.substring(start, end + 1)) as AISuggestResponse
  } catch {
    return null
  }
}

export class OpenAICompatProvider implements AIProvider {
  name: string
  config: OpenAICompatConfig

  constructor(config: OpenAICompatConfig) {
    this.config = config
    this.name = `openai-compat:${config.endpoint}`
  }

  async suggest(req: SuggestRequest): Promise<SuggestResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: `${req.context}\n\n${req.userPrompt}` }
    ]
    return this.call(messages)
  }

  async refine(req: RefineRequest): Promise<SuggestResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: req.systemPrompt },
      // Replay conversation history.
      ...req.conversationHistory.map((turn) => ({
        role: turn.role as 'user' | 'assistant',
        content: turn.content
      })),
      // Append the new refinement message with current state.
      { role: 'user', content: `Current annotation state:\n${req.currentAnnotation}\n\n${req.userMessage}` }
    ]
    return this.call(messages)
  }

  private async call(messages: ChatMessage[]): Promise<SuggestResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`

    const res = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.config.model, messages })
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI-compat API error ${res.status}: ${body}`)
    }

    const data = (await res.json()) as CompletionResponse
    const content = data.choices?.[0]?.message?.content ?? ''

    return {
      raw: content,
      parsed: extractJson(content),
      sessionId: null
    }
  }
}
