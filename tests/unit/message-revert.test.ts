import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readMessageRevertTarget, revertSessionMessage, type MessageRevertTarget
} from '../../src/main/agent/message-revert'
import type { ImageContent } from '../../src/shared/types'

const roots: string[] = []
const images: ImageContent[] = [
  { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
  { type: 'image', data: 'c2Vjb25k', mimeType: 'image/webp' }
]

function createSession(metadata = false) {
  const root = mkdtempSync(join(tmpdir(), 'pion-message-revert-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  const manager = SessionManager.create(project, join(root, 'sessions'))
  if (metadata) {
    manager.appendModelChange('anthropic', 'fixture-model')
    manager.appendThinkingLevelChange('high')
    manager.appendCustomEntry('pion-mode', { mode: 'plan' })
    manager.appendSessionInfo('Keep this name')
  }
  return { manager, project }
}

function user(manager: SessionManager, content: string | ({ type: 'text'; text: string } | ImageContent)[] = 'selected') {
  return manager.appendMessage({ role: 'user', content, timestamp: 1 })
}

// A real assistant entry causes the SDK to flush a newly created session.
function assistant(manager: SessionManager) {
  return manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'reply' }], timestamp: 2,
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture-model', stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  })
}

function targetFor(manager: SessionManager, entryId: string): MessageRevertTarget {
  return { sessionPath: manager.getSessionFile()!, sessionId: manager.getSessionId(), entryId, expectedLeafId: manager.getLeafId() }
}

function expectRejectedUnchanged(target: MessageRevertTarget) {
  const before = readFileSync(target.sessionPath)
  for (const operation of [readMessageRevertTarget, revertSessionMessage]) {
    expect(() => operation(target)).toThrow()
    expect(readFileSync(target.sessionPath)).toEqual(before)
  }
}

function damageEntries(source: string, mutate: (entries: Record<string, unknown>[]) => void): string {
  const entries = source.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  mutate(entries)
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

describe('SDK-only message revert', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('prepares without mutation, restores exact text/images, and durably preserves the old branch in the same file', () => {
    const { manager, project } = createSession()
    const first = user(manager, 'earlier')
    const reply = assistant(manager)
    const parentId = manager.appendThinkingLevelChange('high')
    const prefix = '  请修改 @src/a.ts\r\n<file path="src/a.ts">\n原文\n</file>\n'
    const suffix = '\n尾部\t  '
    const selected = user(manager, [{ type: 'text', text: prefix }, images[0], { type: 'text', text: suffix }, images[1]])
    assistant(manager)
    user(manager, 'subsequent prompt')
    assistant(manager)
    const target = targetFor(manager, selected)
    const oldEntries = manager.getEntries()
    const before = readFileSync(target.sessionPath, 'utf8')
    const projectFile = join(project, 'keep.txt')
    writeFileSync(projectFile, 'changes made after the selected prompt')

    const preview = readMessageRevertTarget(target)
    expect(preview).toEqual({ sessionPath: target.sessionPath, sessionId: target.sessionId,
      entryId: selected, previousLeafId: target.expectedLeafId, text: prefix + suffix, images })
    expect(preview).not.toHaveProperty('leafId')
    expect(readFileSync(target.sessionPath, 'utf8')).toBe(before)
    preview.images[0].data = 'mutated preview must not be reused'

    const result = revertSessionMessage(target)
    expect(result).toMatchObject({ text: prefix + suffix, images, sessionPath: target.sessionPath, sessionId: target.sessionId })
    const appended = readFileSync(target.sessionPath, 'utf8')
    expect(appended.startsWith(before)).toBe(true)
    expect(appended.slice(before.length).trim().split('\n')).toHaveLength(1)
    const reopened = SessionManager.open(target.sessionPath)
    expect(reopened.getSessionId()).toBe(target.sessionId)
    expect(reopened.getLeafId()).toBe(result.leafId)
    expect(reopened.getEntries().slice(0, -1)).toEqual(oldEntries)
    expect(reopened.getBranch(target.expectedLeafId!)).toEqual(oldEntries)
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([first, reply, parentId, result.leafId])
    expect(reopened.getEntry(result.leafId)).toMatchObject({ type: 'custom', customType: 'pion-message-revert', parentId,
      data: { version: 1, entryId: selected, previousLeafId: target.expectedLeafId } })
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(readFileSync(projectFile, 'utf8')).toBe('changes made after the selected prompt')

    const replacement = user(reopened, 'edited prompt')
    assistant(reopened)
    const resumed = SessionManager.open(target.sessionPath)
    expect(resumed.getBranch().map((entry) => entry.id)).toContain(replacement)
    expect(resumed.getBranch().map((entry) => entry.id)).not.toContain(selected)
    expect(resumed.getEntry(selected)).toEqual(manager.getEntry(selected))
  })

  it.each([false, true])('reverts the first user message with preceding metadata=%s', (metadata) => {
    const { manager } = createSession(metadata)
    const parentId = manager.getLeafId()
    const selected = user(manager, ' \n原始首条消息\n ')
    assistant(manager)
    const target = targetFor(manager, selected)
    const result = revertSessionMessage(target)
    const reopened = SessionManager.open(target.sessionPath)
    expect(result.text).toBe(' \n原始首条消息\n ')
    expect(result.images).toEqual([])
    expect(reopened.getLeafId()).toBe(result.leafId)
    expect(reopened.getEntry(result.leafId)?.parentId).toBe(parentId)
    expect(reopened.getEntry(selected)).toBeDefined()
    expect(reopened.buildSessionContext().messages).toEqual([])
    if (metadata) {
      expect(reopened.buildSessionContext()).toMatchObject({ thinkingLevel: 'high', model: { provider: 'anthropic', modelId: 'fixture-model' } })
      expect(reopened.getSessionName()).toBe('Keep this name')
      expect(reopened.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'pion-mode')).toBe(true)
    } else {
      expect(reopened.getBranch().map((entry) => entry.id)).toEqual([result.leafId])
      expect(reopened.getTree()).toHaveLength(2)
    }
  })

  it('accepts an image-only user at the current leaf', () => {
    const { manager } = createSession()
    user(manager, 'earlier')
    const parentId = assistant(manager)
    const selected = user(manager, images)
    const target = targetFor(manager, selected)
    expect(target.expectedLeafId).toBe(selected)
    const result = revertSessionMessage(target)
    const reopened = SessionManager.open(target.sessionPath)
    expect(result).toMatchObject({ text: '', images, previousLeafId: selected })
    expect(reopened.getEntry(result.leafId)?.parentId).toBe(parentId)
    expect(reopened.getEntry(selected)).toBeDefined()
    expect(reopened.getBranch().some((entry) => entry.id === selected)).toBe(false)
  })

  it.each(['before', 'after'] as const)('follows ancestry %s a compaction boundary, not the compacted projection', (position) => {
    const { manager } = createSession()
    const old = user(manager, 'summarized prompt')
    assistant(manager)
    const kept = user(manager, 'kept prompt')
    assistant(manager)
    const compact = manager.appendCompaction('summary', kept, 100)
    const recent = user(manager, 'recent prompt')
    assistant(manager)
    expect(manager.buildContextEntries().some((entry) => entry.id === old)).toBe(false)
    const selected = position === 'before' ? old : recent
    const result = revertSessionMessage(targetFor(manager, selected))
    const reopened = SessionManager.open(result.sessionPath)
    expect(result.text).toBe(position === 'before' ? 'summarized prompt' : 'recent prompt')
    expect(reopened.getEntry(compact)).toBeDefined()
    expect(reopened.getBranch().some((entry) => entry.id === compact)).toBe(position === 'after')
    expect(reopened.getBranch().some((entry) => entry.id === selected)).toBe(false)
    expect(reopened.buildSessionContext().messages.map((message) => message.role))
      .toEqual(position === 'before' ? [] : ['compactionSummary', 'user', 'assistant'])
  })

  it('accepts a prior SDK fork whose branch summary refers to history in the source file', () => {
    const { manager } = createSession()
    user(manager, 'ancestor')
    const parentId = assistant(manager)
    user(manager, 'abandoned')
    const fromId = assistant(manager)
    const summaryId = manager.branchWithSummary(parentId, 'existing branch context')
    const selected = user(manager)
    assistant(manager)
    manager.createBranchedSession(manager.getLeafId()!)
    expect(manager.getEntry(fromId)).toBeUndefined()
    const result = revertSessionMessage(targetFor(manager, selected))
    const reopened = SessionManager.open(result.sessionPath)
    expect(reopened.getEntry(result.leafId)?.parentId).toBe(summaryId)
    expect(reopened.getEntry(summaryId)).toMatchObject({ type: 'branch_summary', fromId })
    expect(reopened.getEntry(selected)).toBeDefined()
  })

  it('revalidates fresh disk state after a preview and rejects wrong session/leaf identities', () => {
    const { manager } = createSession()
    const selected = user(manager)
    assistant(manager)
    const target = targetFor(manager, selected)
    readMessageRevertTarget(target)
    expectRejectedUnchanged({ ...target, sessionId: 'other-session' })
    expectRejectedUnchanged({ ...target, expectedLeafId: null })
    // Sequential change between calls, not a competing live writer.
    SessionManager.open(target.sessionPath).appendSessionInfo('changed after preview')
    expectRejectedUnchanged(target)
  })

  it('rejects repeat, old-branch, missing, and non-user targets without appending another marker', () => {
    const { manager } = createSession()
    user(manager, 'ancestor')
    const reply = assistant(manager)
    const selected = user(manager)
    assistant(manager)
    const target = targetFor(manager, selected)
    const result = revertSessionMessage(target)
    expectRejectedUnchanged(target)
    for (const entryId of [selected, 'missing', reply, result.leafId]) {
      expectRejectedUnchanged({ ...target, entryId, expectedLeafId: result.leafId })
    }
  })

  it('rejects an unpersisted SDK session without creating its assigned path', () => {
    const { manager } = createSession()
    const target = targetFor(manager, user(manager))
    expect(existsSync(target.sessionPath)).toBe(false)
    for (const operation of [readMessageRevertTarget, revertSessionMessage]) expect(() => operation(target)).toThrow()
    expect(existsSync(target.sessionPath)).toBe(false)
  })

  it.each([
    ['empty', () => ''],
    ['missing final LF', (source: string) => source.trimEnd()],
    ['partial tail', (source: string) => source + '{"type":'],
    ['bad JSON line', (source: string) => source + '{broken}\n'],
    ['invalid UTF-8', (source: string) => Buffer.concat([Buffer.from(source), Buffer.from([0xff, 10])])],
    ['null record', (source: string) => source + 'null\n'],
    ['legacy migration', (source: string) => source.replace('"version":3', '"version":2')],
    ['future version', (source: string) => source.replace('"version":3', '"version":999')],
    ['duplicate header', (source: string) => source + source.split('\n')[0] + '\n'],
    ['duplicate ID', (source: string) => source + source.split('\n')[1] + '\n'],
    ['missing parent', (source: string) => source.replace('"parentId":null', '"parentId":"missing"')],
    ['self-cycle', (source: string) => damageEntries(source, (entries) => { entries[1].parentId = entries[1].id })],
    ['forward parent', (source: string) => damageEntries(source, (entries) => { entries[1].parentId = entries[2].id })],
    ['null message', (source: string) => damageEntries(source, (entries) => { entries[2].message = null })],
    ['missing header', (source: string) => source.slice(source.indexOf('\n') + 1)]
  ] satisfies [string, (source: string) => string | Buffer][])('rejects %s before SDK writes and leaves corrupt bytes unchanged', (_name, damage) => {
    const { manager } = createSession()
    const selected = user(manager)
    assistant(manager)
    const target = targetFor(manager, selected)
    writeFileSync(target.sessionPath, damage(readFileSync(target.sessionPath, 'utf8')))
    expectRejectedUnchanged(target)
  })

  it.each([
    null,
    [{ type: 'text', text: 12 }],
    [{ type: 'file', path: '/document.pdf' }],
    [{ type: 'audio', data: 'audio' }],
    [{ type: 'image', data: images[0].data }],
    [{ type: 'image', data: 12, mimeType: 'image/png' }],
    [{ type: 'image', data: images[0].data, mimeType: 'application/pdf' }],
    [{ type: 'text', text: 'visible', attachment: 'hidden' }]
  ].map((content) => ({ content })))('refuses unsupported or malformed selected content %# rather than losing attachments', ({ content }) => {
    const { manager } = createSession()
    const selected = user(manager)
    assistant(manager)
    const target = targetFor(manager, selected)
    readMessageRevertTarget(target)
    const changed = damageEntries(readFileSync(target.sessionPath, 'utf8'), (entries) => {
      (entries[1].message as Record<string, unknown>).content = content
    })
    writeFileSync(target.sessionPath, changed)
    expectRejectedUnchanged(target)
  })

  it('refuses attachment fields outside content instead of restoring only visible text', () => {
    const { manager } = createSession()
    const selected = user(manager)
    assistant(manager)
    const target = targetFor(manager, selected)
    writeFileSync(target.sessionPath, damageEntries(readFileSync(target.sessionPath, 'utf8'), (entries) => {
      (entries[1].message as Record<string, unknown>).attachments = [{ path: 'document.pdf' }]
    }))
    expectRejectedUnchanged(target)
  })
})
