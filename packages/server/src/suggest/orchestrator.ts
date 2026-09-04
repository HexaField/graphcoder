/**
 * Suggest orchestrator — ties together context gathering, AI provider
 * invocation, nodeRef resolution, and annotation persistence.
 */
import type { Annotation, ConversationLog, GraphNode } from '@graphcoder/core'
import {
  createAnnotation,
  saveAnnotation,
  loadAnnotation,
  createConversation,
  saveConversation,
  loadConversation,
  ensureKind
} from '@graphcoder/core/annotations/server'
import { graphService } from '../codegraph/service.js'
import { gatherContext } from './context.js'
import { resolveNodeRefs } from './resolve-refs.js'
import { getProvider, loadProviderConfig } from './providers/index.js'
import { SUGGEST_SKILL } from './skill.js'

/**
 * Suggest a new annotation via an AI provider.
 *
 * 1. Gather context from the CodeGraph.
 * 2. Invoke the AI provider with the skill + context.
 * 3. Resolve nodeRefs from the AI response to semantic IDs.
 * 4. Create a 'proposed' annotation and save to disk.
 * 5. Create a conversation log and save.
 */
export async function suggestAnnotation(opts: {
  prompt: string
  label: string
  /** Optional kind hint passed through to the AI prompt */
  kind?: string
  provider?: string
  depth?: number
}): Promise<{ annotation: Annotation; conversationLog: ConversationLog }> {
  const projectRoot = graphService.getProjectRoot()

  // 1. Gather context.
  const context = gatherContext(opts.prompt, opts.label, opts.kind ?? null, opts.depth ?? 3)

  // 2. Invoke the AI.
  const { defaultProvider, providers } = loadProviderConfig(projectRoot)
  const providerName = opts.provider ?? defaultProvider
  const providerConfig = providers[providerName]
  if (!providerConfig) {
    throw new Error(`Provider '${providerName}' not found in .graphcoder/config.json`)
  }

  const provider = getProvider(providerName, providerConfig)
  const result = await provider.suggest({
    systemPrompt: SUGGEST_SKILL,
    context: JSON.stringify(context),
    userPrompt: opts.prompt
  })

  if (!result.parsed || result.parsed.annotations.length === 0) {
    throw new Error(`AI provider '${providerName}' returned no parseable annotations. Raw: ${result.raw.slice(0, 500)}`)
  }

  // 3. Resolve nodeRefs.
  const { nodes: allNodes } = graphService.getAllNodesAndEdges()
  const graphNodes = allNodes as unknown as GraphNode[]

  const aiAnnotation = result.parsed.annotations[0]!
  const resolutions = resolveNodeRefs(aiAnnotation.nodeRefs, graphNodes)
  const semanticMembers = resolutions.filter((r) => r.semanticId !== null).map((r) => r.semanticId!)

  // 4. Create and save annotation. Member order carries the traversal for
  //    polyline suggestions, so no parallel step structure is needed.
  const annotation = createAnnotation(aiAnnotation.shape, aiAnnotation.label, semanticMembers, {
    kind: aiAnnotation.kind,
    description: aiAnnotation.description,
    reasoning: aiAnnotation.reasoning,
    status: 'proposed',
    author: 'agent'
  })
  saveAnnotation(projectRoot, annotation)

  // 5. Register the kind the AI coined so it gets a stable colour.
  if (annotation.kind) ensureKind(projectRoot, annotation.kind)

  // 6. Create conversation log.
  const conversationLog = createConversation(annotation.id, providerName, result.sessionId)
  conversationLog.turns.push({
    role: 'assistant',
    content: result.raw,
    timestamp: new Date().toISOString(),
    annotationDelta: {
      shape: aiAnnotation.shape,
      kind: aiAnnotation.kind,
      label: aiAnnotation.label,
      description: aiAnnotation.description,
      members: semanticMembers
    } as Partial<Annotation>
  })
  saveConversation(projectRoot, conversationLog)

  return { annotation, conversationLog }
}

/**
 * Refine an existing proposed annotation via conversational exchange.
 *
 * 1. Load the annotation and its conversation log.
 * 2. Re-gather context (the graph may have changed).
 * 3. Send the refinement message + current state to the AI.
 * 4. Apply the AI's response to update the annotation.
 * 5. Persist both the annotation and conversation.
 */
export async function refineAnnotation(opts: {
  annotationId: string
  message: string
  provider?: string
}): Promise<{ annotation: Annotation; conversationLog: ConversationLog }> {
  const projectRoot = graphService.getProjectRoot()

  // 1. Load annotation and conversation.
  const annotation = loadAnnotation(projectRoot, opts.annotationId)
  if (!annotation) {
    throw new Error(`Annotation '${opts.annotationId}' not found`)
  }

  let conversationLog = loadConversation(projectRoot, opts.annotationId)
  if (!conversationLog) {
    conversationLog = createConversation(opts.annotationId, 'unknown')
  }

  // 2. Re-gather context.
  const context = gatherContext(annotation.description || annotation.label, annotation.label, annotation.kind, 3)

  // 3. Get the provider.
  const { defaultProvider, providers } = loadProviderConfig(projectRoot)
  const providerName = opts.provider ?? conversationLog.provider ?? defaultProvider
  const providerConfig = providers[providerName]
  if (!providerConfig) {
    throw new Error(`Provider '${providerName}' not found in .graphcoder/config.json`)
  }

  const provider = getProvider(providerName, providerConfig)

  // Append the user turn before calling the provider.
  conversationLog.turns.push({
    role: 'user',
    content: opts.message,
    timestamp: new Date().toISOString(),
    annotationDelta: null
  })

  const result = await provider.refine({
    systemPrompt: SUGGEST_SKILL,
    context: JSON.stringify(context),
    conversationHistory: conversationLog.turns,
    userMessage: opts.message,
    currentAnnotation: JSON.stringify(annotation),
    sessionId: conversationLog.sessionId
  })

  // 4. Apply the AI's response.
  const { nodes: allNodes } = graphService.getAllNodesAndEdges()
  const graphNodes = allNodes as unknown as GraphNode[]

  if (result.parsed && result.parsed.annotations.length > 0) {
    const aiUpdate = result.parsed.annotations[0]!
    const resolutions = resolveNodeRefs(aiUpdate.nodeRefs, graphNodes)
    const newMembers = resolutions.filter((r) => r.semanticId !== null).map((r) => r.semanticId!)

    annotation.label = aiUpdate.label
    annotation.description = aiUpdate.description
    annotation.reasoning = aiUpdate.reasoning
    annotation.members = newMembers
    annotation.shape = aiUpdate.shape
    if (aiUpdate.kind) annotation.kind = aiUpdate.kind
  }

  // 5. Persist.
  saveAnnotation(projectRoot, annotation)
  if (annotation.kind) ensureKind(projectRoot, annotation.kind)

  conversationLog.turns.push({
    role: 'assistant',
    content: result.raw,
    timestamp: new Date().toISOString(),
    annotationDelta: result.parsed?.annotations[0]
      ? ({
          label: annotation.label,
          description: annotation.description,
          members: annotation.members
        } as Partial<Annotation>)
      : null
  })

  if (result.sessionId) conversationLog.sessionId = result.sessionId
  saveConversation(projectRoot, conversationLog)

  return { annotation, conversationLog }
}
