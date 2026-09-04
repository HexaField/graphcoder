/**
 * Test provider — returns deterministic responses for e2e testing.
 * No external AI invocation. Uses the context's matched nodes directly.
 */
import type { AIProvider, SuggestRequest, SuggestResult, RefineRequest } from './types.js'
import type { AISuggestResponse } from '@graphcoder/core'
import type { SuggestContext } from '../context.js'

export class TestProvider implements AIProvider {
  name = 'test'

  async suggest(req: SuggestRequest): Promise<SuggestResult> {
    const context = JSON.parse(req.context) as SuggestContext
    const nodeRefs = context.matchedNodes.slice(0, 3).map((n) => ({
      name: n.name,
      kind: n.kind,
      filePath: n.filePath
    }))

    const response: AISuggestResponse = {
      annotations: [
        {
          kind: 'boundary',
          label: context.label,
          description: `AI-suggested boundary for: ${context.prompt}`,
          nodeRefs,
          reasoning: 'Test provider — deterministic response for testing.'
        }
      ],
      parentAnnotation: null
    }

    return {
      raw: JSON.stringify(response),
      parsed: response,
      sessionId: 'test-session-1'
    }
  }

  async refine(req: RefineRequest): Promise<SuggestResult> {
    const context = JSON.parse(req.context) as SuggestContext
    const nodeRefs = context.matchedNodes.slice(0, 3).map((n) => ({
      name: n.name,
      kind: n.kind,
      filePath: n.filePath
    }))

    const response: AISuggestResponse = {
      annotations: [
        {
          kind: 'boundary',
          label: context.label,
          description: `Refined: ${req.userMessage}`,
          nodeRefs,
          reasoning: `Test provider — refined with user feedback: "${req.userMessage}"`
        }
      ],
      parentAnnotation: null
    }

    return {
      raw: JSON.stringify(response),
      parsed: response,
      sessionId: 'test-session-1'
    }
  }
}
