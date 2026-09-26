import { isUtf8 } from 'node:buffer'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent'
import { messageImages, messageText, type ImageContent, type WireMessage } from '../../shared/types'

export interface MessageRevertTarget {
  sessionPath: string
  sessionId: string
  entryId: string
  expectedLeafId: string | null
}

/** Detached preview data; no manager or authority to mutate is retained. */
export interface PreparedMessageRevert {
  sessionPath: string
  sessionId: string
  entryId: string
  previousLeafId: string | null
  text: string
  images: ImageContent[]
}

export interface MessageRevertResult extends PreparedMessageRevert {
  /** ID of the durable custom marker, not the selected message or its parent. */
  leafId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function contentShape(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value)
    && value.every((part) => isRecord(part) && nonemptyString(part.type)))
}

function finiteNonnegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function usageShape(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cost)) return false
  const cost = value.cost
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((key) => finiteNonnegative(value[key]))
    && ['cacheWrite1h', 'reasoning'].every((key) => value[key] === undefined || finiteNonnegative(value[key]))
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((key) => finiteNonnegative(cost[key]))
}

/** The SDK's ContextEditableContent union, not a bare replacement string/array. */
function editableContentShape(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (!Array.isArray(value) || !value.every(isRecord)) return false
  // The union permits user/custom/tool-result blocks OR assistant blocks.
  if (!value.every((part) => ['text', 'image'].includes(String(part.type)))
    && !value.every((part) => ['text', 'thinking', 'toolCall'].includes(String(part.type)))) return false
  return value.every((part) => {
    switch (part.type) {
      case 'text':
        return typeof part.text === 'string' && (part.textSignature === undefined || typeof part.textSignature === 'string')
      case 'image':
        return typeof part.data === 'string' && typeof part.mimeType === 'string'
      case 'thinking':
        return typeof part.thinking === 'string'
          && (part.thinkingSignature === undefined || typeof part.thinkingSignature === 'string')
          && (part.redacted === undefined || typeof part.redacted === 'boolean')
      case 'toolCall':
        return nonemptyString(part.id) && nonemptyString(part.name) && isRecord(part.arguments)
          && (part.thoughtSignature === undefined || typeof part.thoughtSignature === 'string')
          && (part.namespace === undefined || typeof part.namespace === 'string')
      default:
        return false
    }
  })
}

function contextEditShape(entry: Record<string, unknown>, prior: Map<string, Record<string, unknown>>): boolean {
  if (!nonemptyString(entry.targetId)) return false
  const target = prior.get(entry.targetId)
  if (!target || !(target.type === 'custom_message' || (target.type === 'message'
    && isRecord(target.message) && (target.message.role === 'user'
      || target.message.role === 'assistant' || target.message.role === 'toolResult')))) return false
  // Existing elsewhere in the old tree is insufficient: edits are branch-local.
  let ancestor = entry.parentId
  while (typeof ancestor === 'string' && ancestor !== entry.targetId) ancestor = prior.get(ancestor)?.parentId
  if (ancestor !== entry.targetId) return false
  return entry.replacement === null || (isRecord(entry.replacement)
    && Object.keys(entry.replacement).every((key) => key === 'content')
    && editableContentShape(entry.replacement.content))
}

/** Check the fields the SDK dereferences; extension data remains opaque. */
function entryShape(entry: Record<string, unknown>, prior: Map<string, Record<string, unknown>>): boolean {
  switch (entry.type) {
    case 'message': {
      const message = entry.message
      if (!isRecord(message) || !nonemptyString(message.role)) return false
      if (message.role === 'bashExecution') {
        return typeof message.command === 'string' && typeof message.output === 'string'
      }
      return contentShape(message.content)
    }
    case 'usage':
      // Unknown categories are valid: kind is an open SDK string, not an enum.
      return typeof entry.kind === 'string' && nonemptyString(entry.provider) && nonemptyString(entry.model)
        && usageShape(entry.usage) && (entry.note === undefined || typeof entry.note === 'string')
    case 'context_edit':
      return contextEditShape(entry, prior)
    case 'model_change':
      return nonemptyString(entry.provider) && nonemptyString(entry.modelId)
    case 'thinking_level_change':
      return nonemptyString(entry.thinkingLevel)
    case 'compaction':
      // SDK 0.87.1 uses the compaction's own ID for retain-none, not a missing ancestor.
      return typeof entry.summary === 'string'
        && typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0
        && nonemptyString(entry.firstKeptEntryId)
        && (entry.firstKeptEntryId === entry.id || prior.has(entry.firstKeptEntryId))
    case 'branch_summary':
      // SDK forks can retain a summary whose source lives only in the old file.
      return typeof entry.summary === 'string' && nonemptyString(entry.fromId)
    case 'custom':
      return nonemptyString(entry.customType)
    case 'custom_message':
      return nonemptyString(entry.customType) && contentShape(entry.content) && typeof entry.display === 'boolean'
    case 'label':
      return nonemptyString(entry.targetId) && prior.has(entry.targetId)
        && (entry.label === undefined || typeof entry.label === 'string')
    case 'session_info':
      return entry.name === undefined || typeof entry.name === 'string'
    default:
      return false
  }
}

/**
 * SDK open() can migrate/rewrite legacy files, initialize empty files, skip bad
 * JSON, and repair a missing final LF. Reject all of those before giving it the
 * path. This is validation only: Pion never repairs or rewrites the JSONL here.
 */
function validateSessionFile(sessionPath: string): void {
  const file = statSync(sessionPath)
  if (!file.isFile() || file.size === 0) throw new Error('会话尚未持久化或文件为空')
  const bytes = readFileSync(sessionPath)
  if (!isUtf8(bytes) || bytes.at(-1) !== 10) {
    throw new Error('会话文件不完整，无法安全回退')
  }
  let headerSeen = false
  const prior = new Map<string, Record<string, unknown>>()
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      throw new Error('会话文件包含损坏的记录，无法安全回退')
    }
    if (!isRecord(entry) || !nonemptyString(entry.id)
      || !nonemptyString(entry.timestamp) || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new Error('会话记录格式无效，无法安全回退')
    }
    if (!headerSeen) {
      if (entry.type !== 'session' || entry.version !== CURRENT_SESSION_VERSION || !nonemptyString(entry.cwd)) {
        throw new Error('会话格式无效或需要升级，无法安全回退')
      }
      headerSeen = true
      continue
    }
    // An append-only tree can have multiple roots after resetLeaf(), but every
    // non-root parent must already exist. This also rules out cycles and orphans
    // before calling SDK traversal methods (which do not guard against cycles).
    if (prior.has(entry.id)
      || (entry.parentId !== null && (!nonemptyString(entry.parentId) || !prior.has(entry.parentId)))
      || !entryShape(entry, prior)) {
      throw new Error('会话树记录无效，无法安全回退')
    }
    prior.set(entry.id, entry)
  }
  if (!headerSeen) throw new Error('会话文件为空，无法安全回退')
}

function restoreContent(message: WireMessage): Pick<PreparedMessageRevert, 'text' | 'images'> {
  const unsupported = () => new Error('该消息包含无法完整恢复的内容，未回退消息')
  // Unknown attachment-bearing fields/blocks must not disappear through the
  // permissive shared projection helpers. References already in text stay exact.
  if (Object.keys(message).some((key) => !['role', 'content', 'timestamp'].includes(key))) throw unsupported()
  if (typeof message.content !== 'string') {
    if (!Array.isArray(message.content)) throw unsupported()
    for (const part of message.content) {
      if (!isRecord(part)) throw unsupported()
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || Object.keys(part).some((key) => !['type', 'text'].includes(key))) {
          throw unsupported()
        }
      } else if (part.type === 'image') {
        if (!nonemptyString(part.data) || !nonemptyString(part.mimeType) || !/^image\/\S+$/.test(part.mimeType)
          || Object.keys(part).some((key) => !['type', 'data', 'mimeType'].includes(key))) {
          throw unsupported()
        }
      } else {
        throw unsupported()
      }
    }
  }
  return { text: messageText(message), images: messageImages(message) }
}

function prepare(target: MessageRevertTarget): {
  manager: SessionManager
  parentId: string | null
  prepared: PreparedMessageRevert
} {
  if (!target || !nonemptyString(target.sessionPath) || !nonemptyString(target.sessionId)
    || !nonemptyString(target.entryId) || (target.expectedLeafId !== null && !nonemptyString(target.expectedLeafId))) {
    throw new Error('无效的消息回退目标')
  }
  const sessionPath = resolve(target.sessionPath)
  validateSessionFile(sessionPath)
  const manager = SessionManager.open(sessionPath)
  if (manager.getSessionId() !== target.sessionId) throw new Error('会话已变化，请刷新后重试')
  const previousLeafId = manager.getLeafId()
  if (previousLeafId !== target.expectedLeafId) throw new Error('会话分支已变化，请刷新后重试')
  // Use full ancestry, not compacted LLM context or physical JSONL order.
  const entry = manager.getBranch().find((candidate) => candidate.id === target.entryId)
  if (!entry || entry.type !== 'message' || entry.message.role !== 'user') {
    throw new Error('只能回退当前分支上的用户消息')
  }
  const content = restoreContent(entry.message as unknown as WireMessage)
  return {
    manager,
    parentId: entry.parentId,
    prepared: { sessionPath, sessionId: manager.getSessionId(), entryId: entry.id, previousLeafId, ...content }
  }
}

/**
 * Read-only, fresh validation/preview. Caller owns exclusive session access:
 * stop the old idle backend and await its actual process exit before invoking
 * either helper; keep backend recreation and other writers excluded throughout.
 * An expected leaf is a stale-target check, NOT a writer lock or idle check.
 */
export function readMessageRevertTarget(target: MessageRevertTarget): PreparedMessageRevert {
  return prepare(target).prepared
}

/**
 * Move BEFORE the selected user entry in the SAME session. Caller must meet the
 * exclusive-access precondition above. No model, extension, or project-file
 * operations are involved. Never reuse a manager captured by the preview.
 */
export function revertSessionMessage(target: MessageRevertTarget): MessageRevertResult {
  const { manager, parentId, prepared } = prepare(target)
  if (parentId === null) manager.resetLeaf()
  else manager.branch(parentId)
  // branch/resetLeaf alone only move an in-memory pointer. A plain custom entry
  // persists the new leaf on reopen without reintroducing abandoned LLM context.
  const leafId = manager.appendCustomEntry('pion-message-revert', {
    version: 1,
    entryId: prepared.entryId,
    previousLeafId: prepared.previousLeafId
  })
  return { ...prepared, leafId }
}
