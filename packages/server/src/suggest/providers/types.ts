/**
 * AI provider interface — the contract every suggest/refine provider implements.
 */
import type { AISuggestResponse, ConversationTurn } from '@graphcoder/core'

export interface SuggestRequest {
  systemPrompt: string
  context: string // JSON-serialized SuggestContext
  userPrompt: string
}

export interface SuggestResult {
  raw: string
  parsed: AISuggestResponse | null
  sessionId: string | null
}

export interface RefineRequest {
  systemPrompt: string
  context: string
  conversationHistory: ConversationTurn[]
  userMessage: string
  currentAnnotation: string // JSON-serialized Annotation
  sessionId: string | null
}

export interface AIProvider {
  name: string
  suggest(req: SuggestRequest): Promise<SuggestResult>
  refine(req: RefineRequest): Promise<SuggestResult>
}

/** Discriminated union for provider configuration. */
export type ProviderConfig =
  | { type?: 'cli'; command: string; args: string[]; sessionResume: boolean }
  | { type: 'openai-compat'; endpoint: string; model: string; apiKey?: string }
  | { type: 'test' }
