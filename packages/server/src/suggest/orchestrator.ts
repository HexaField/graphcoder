import type { Annotation, AnnotationMember, ConversationLog, GraphNode } from '@graphcoder/core'
import { deriveShape } from '@graphcoder/core'
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

function resolvedMembers(
  aiNodeRefs: import('@graphcoder/core').NodeRef[],
  graphNodes: GraphNode[]
): AnnotationMember[] {
  const resolutions = resolveNodeRefs(aiNodeRefs, graphNodes)
  return resolutions
    .filter((r) => r.semanticId !== null)
    .map((r) => ({
      id: r.semanticId!,
      ref: r.ref.name,
      file: r.ref.filePath,
      note: ''
    }))
}

export async function suggestAnnotation(opts: {
  prompt: string
  label: string
  kind?: string
  provider?: string
  depth?: number
}): Promise<{ annotation: Annotation; conversationLog: ConversationLog }> {
  const projectRoot = graphService.getProjectRoot()
  const context = gatherContext(opts.prompt, opts.label, opts.kind ?? null, opts.depth ?? 3)

  const { defaultProvider, providers } = loadProviderConfig(projectRoot)
  const providerName = opts.provider ?? defaultProvider
  const providerConfig = providers[providerName]
  if (!providerConfig) throw new Error(`Provider '${providerName}' not found in .graphcoder/config.json`)

  const provider = getProvider(providerName, providerConfig)
  const result = await provider.suggest({
    systemPrompt: SUGGEST_SKILL,
    context: JSON.stringify(context),
    userPrompt: opts.prompt
  })

  if (!result.parsed || result.parsed.annotations.length === 0) {
    throw new Error(`AI provider '${providerName}' returned no parseable annotations. Raw: ${result.raw.slice(0, 500)}`)
  }

  const { nodes: allNodes } = graphService.getAllNodesAndEdges()
  const graphNodes = allNodes as unknown as GraphNode[]

  const aiAnnotation = result.parsed.annotations[0]!
  const members = resolvedMembers(aiAnnotation.nodeRefs, graphNodes)
  const ordered = aiAnnotation.shape === 'polyline'

  const annotation = createAnnotation(aiAnnotation.label, members, {
    kind: aiAnnotation.kind,
    description: aiAnnotation.description,
    reasoning: aiAnnotation.reasoning,
    ordered,
    status: 'proposed',
    author: 'agent'
  })
  const slug = saveAnnotation(projectRoot, annotation)
  annotation.id = slug

  if (annotation.kind) ensureKind(projectRoot, annotation.kind)

  const conversationLog = createConversation(annotation.id, providerName, result.sessionId)
  conversationLog.turns.push({
    role: 'assistant',
    content: result.raw,
    timestamp: new Date().toISOString(),
    annotationDelta: null
  })
  saveConversation(projectRoot, conversationLog)

  return { annotation, conversationLog }
}

export async function refineAnnotation(opts: {
  annotationId: string
  message: string
  provider?: string
}): Promise<{ annotation: Annotation; conversationLog: ConversationLog }> {
  const projectRoot = graphService.getProjectRoot()

  const annotation = loadAnnotation(projectRoot, opts.annotationId)
  if (!annotation) throw new Error(`Annotation '${opts.annotationId}' not found`)

  let conversationLog = loadConversation(projectRoot, opts.annotationId)
  if (!conversationLog) conversationLog = createConversation(opts.annotationId, 'unknown')

  const context = gatherContext(annotation.description || annotation.label, annotation.label, annotation.kind, 3)

  const { defaultProvider, providers } = loadProviderConfig(projectRoot)
  const providerName = opts.provider ?? conversationLog.provider ?? defaultProvider
  const providerConfig = providers[providerName]
  if (!providerConfig) throw new Error(`Provider '${providerName}' not found in .graphcoder/config.json`)

  const provider = getProvider(providerName, providerConfig)

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

  const { nodes: allNodes } = graphService.getAllNodesAndEdges()
  const graphNodes = allNodes as unknown as GraphNode[]

  if (result.parsed && result.parsed.annotations.length > 0) {
    const aiUpdate = result.parsed.annotations[0]!
    const newMembers = resolvedMembers(aiUpdate.nodeRefs, graphNodes)
    annotation.label = aiUpdate.label
    annotation.description = aiUpdate.description
    annotation.reasoning = aiUpdate.reasoning
    annotation.members = newMembers
    annotation.ordered = aiUpdate.shape === 'polyline'
    annotation.shape = deriveShape(annotation.ordered, newMembers.length)
    if (aiUpdate.kind) annotation.kind = aiUpdate.kind
  }

  saveAnnotation(projectRoot, annotation)
  if (annotation.kind) ensureKind(projectRoot, annotation.kind)

  conversationLog.turns.push({
    role: 'assistant',
    content: result.raw,
    timestamp: new Date().toISOString(),
    annotationDelta: null
  })
  if (result.sessionId) conversationLog.sessionId = result.sessionId
  saveConversation(projectRoot, conversationLog)

  return { annotation, conversationLog }
}
