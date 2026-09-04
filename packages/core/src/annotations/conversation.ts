/**
 * Conversation store — file-backed persistence for AI refinement conversations.
 *
 * Each proposed annotation can have a companion conversation file:
 *   .graphcoder/annotations/{uuid}.conversation.json
 *
 * The conversation tracks the full exchange between the user and the AI,
 * including any annotation deltas the AI proposes at each turn.
 */
import type { ConversationLog, ConversationTurn } from './types.js'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ANNOTATIONS_DIR = 'annotations'

function conversationPath(projectRoot: string, annotationId: string): string {
  return join(projectRoot, '.graphcoder', ANNOTATIONS_DIR, `${annotationId}.conversation.json`)
}

/** Load a conversation log for an annotation. Returns null when no conversation exists. */
export function loadConversation(projectRoot: string, annotationId: string): ConversationLog | null {
  const filePath = conversationPath(projectRoot, annotationId)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as ConversationLog
  } catch {
    return null
  }
}

/** Save (overwrite) a conversation log to disk. */
export function saveConversation(projectRoot: string, log: ConversationLog): void {
  const filePath = conversationPath(projectRoot, log.annotationId)
  writeFileSync(filePath, JSON.stringify(log, null, 2) + '\n', 'utf-8')
}

/** Create a new empty conversation log for an annotation. */
export function createConversation(
  annotationId: string,
  provider: string,
  sessionId: string | null = null
): ConversationLog {
  return {
    annotationId,
    provider,
    sessionId,
    turns: []
  }
}

/** Append a turn to an existing conversation and persist. */
export function appendTurn(projectRoot: string, annotationId: string, turn: ConversationTurn): ConversationLog {
  let log = loadConversation(projectRoot, annotationId)
  if (!log) {
    log = createConversation(annotationId, 'unknown')
  }
  log.turns.push(turn)
  saveConversation(projectRoot, log)
  return log
}

/** Delete a conversation file. Returns true when the file existed. */
export function deleteConversation(projectRoot: string, annotationId: string): boolean {
  const filePath = conversationPath(projectRoot, annotationId)
  if (!existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}
