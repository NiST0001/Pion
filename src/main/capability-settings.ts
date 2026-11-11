import { open, type FileHandle } from 'node:fs/promises'
import { writeAtomicJson } from './atomic-json-file'
import {
  DEFAULT_CAPABILITY_PREFERENCES, PI_CORE_TOOL_NAMES,
  type CapabilityChange, type CapabilityItem, type CapabilityPreferences
} from '../shared/capability-settings'

const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 4096
const GROUPS = ['tool', 'mcp', 'skill', 'extension'] as const

class CapabilitySettingsError extends Error {}
function invalid(message = '能力开关设置无效'): never { throw new CapabilitySettingsError(message) }

function record(value: unknown, maxKeys: number, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const keys = Object.keys(value)
  if (keys.length > maxKeys || (fields && (keys.length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))))) invalid()
  return value as Record<string, unknown>
}

function validId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (/^tool:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(value)) return true
  return /^(?:mcp|skill|extension):[a-f0-9]{64}(?![\s\S])/.test(value)
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function clone(value: CapabilityPreferences): CapabilityPreferences {
  return {
    version: 1, revision: value.revision, defaults: { ...value.defaults },
    overrides: Object.assign(Object.create(null), value.overrides) as Record<string, boolean>
  }
}

export function validateCapabilityPreferences(value: unknown): CapabilityPreferences {
  const root = record(value, 4, ['version', 'revision', 'defaults', 'overrides'])
  if (root.version !== 1 || !validRevision(root.revision)) invalid()
  const defaults = record(root.defaults, GROUPS.length, GROUPS)
  for (const group of GROUPS) {
    if (typeof defaults[group] !== 'boolean' && defaults[group] !== 'inherit') invalid()
  }
  const source = record(root.overrides, MAX_ENTRIES)
  const overrides: Record<string, boolean> = Object.create(null)
  for (const [id, enabled] of Object.entries(source)) {
    if (!validId(id) || typeof enabled !== 'boolean') invalid()
    overrides[id] = enabled
  }
  const preferences: CapabilityPreferences = {
    version: 1, revision: root.revision,
    defaults: {
      tool: defaults.tool as boolean | 'inherit', mcp: defaults.mcp as boolean | 'inherit',
      skill: defaults.skill as boolean | 'inherit', extension: defaults.extension as boolean | 'inherit'
    },
    overrides
  }
  if (Buffer.byteLength(`${JSON.stringify(preferences)}\n`, 'utf8') > MAX_FILE_BYTES) invalid('能力开关设置超过 256 KiB')
  return preferences
}

/** An omitted runtime path preserves Pi's existing behavior, without doing IO. */
export async function readCapabilityPreferences(path?: string): Promise<CapabilityPreferences> {
  if (path === undefined) return clone(DEFAULT_CAPABILITY_PREFERENCES)
  if (typeof path !== 'string' || !path || path.includes('\0')) invalid('能力开关设置路径无效')
  let file: FileHandle
  try { file = await open(path, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clone(DEFAULT_CAPABILITY_PREFERENCES)
    invalid('能力开关设置读取失败')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile()) invalid('能力开关设置必须是普通文件')
    if (stat.size > MAX_FILE_BYTES) invalid('能力开关设置文件超过 256 KiB')
    // The extra byte also rejects a file that grows after stat, without readFile.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_FILE_BYTES) invalid('能力开关设置文件超过 256 KiB')
    return validateCapabilityPreferences(JSON.parse(buffer.subarray(0, length).toString('utf8')))
  } catch (error) {
    if (error instanceof CapabilitySettingsError) throw error
    // Neither JSON syntax errors nor filesystem diagnostics may echo file contents.
    return invalid('能力开关设置读取或解析失败')
  } finally {
    try { await file.close() } catch { invalid('能力开关设置读取收尾失败') }
  }
}

function captureChange(value: CapabilityChange, items: readonly CapabilityItem[]): CapabilityChange {
  if (!Array.isArray(items) || items.length > MAX_ENTRIES) invalid('能力目录无效或超过上限')
  const change = record(value, 3)
  if (change.type === 'preset') {
    record(value, 2, ['type', 'preset'])
    if (change.preset !== 'minimal' && change.preset !== 'standard' && change.preset !== 'no-skills') invalid('能力开关预设无效')
    return { type: 'preset', preset: change.preset }
  }
  record(value, 3, ['type', 'id', 'enabled'])
  if (change.type !== 'toggle' || !validId(change.id) || typeof change.enabled !== 'boolean') invalid('能力开关参数无效')
  // Capture exact membership before a queued write; no text/name matching or aliases.
  const id = change.id
  if (!items.some((item) => item && item.id === id && (
    item.kind === 'subagent' ? id === 'tool:pion_subagents' : id.startsWith(`${item.kind}:`)
  ))) invalid('能力开关不在当前目录中')
  return { type: 'toggle', id, enabled: change.enabled }
}

function applyChange(current: CapabilityPreferences, change: CapabilityChange): CapabilityPreferences {
  const next = clone(current)
  if (next.revision === Number.MAX_SAFE_INTEGER) invalid('能力开关设置修订号已达上限')
  next.revision++
  if (change.type === 'toggle') next.overrides[change.id] = change.enabled
  else if (change.preset === 'no-skills') {
    next.defaults.skill = false
    for (const id of Object.keys(next.overrides)) if (id.startsWith('skill:')) delete next.overrides[id]
  } else {
    const enabled = change.preset === 'standard'
    next.defaults = { tool: enabled, mcp: enabled, skill: enabled, extension: enabled }
    next.overrides = Object.create(null) as Record<string, boolean>
    if (!enabled) for (const name of PI_CORE_TOOL_NAMES) next.overrides[`tool:${name}`] = true
  }
  return validateCapabilityPreferences(next)
}

/** Pion's own file only. Presets are single writes, not retained modes. */
export class CapabilitySettingsStore {
  private preferences: CapabilityPreferences | undefined
  private loadFailure: { error: unknown } | undefined
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  private readonly listeners = new Set<(prefs: CapabilityPreferences) => void>()

  constructor(readonly filePath: string) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) invalid('能力开关设置路径无效')
  }

  private async load(retry = false): Promise<void> {
    if (this.preferences) return
    if (this.loadFailure && !retry) throw this.loadFailure.error
    try {
      this.preferences = await readCapabilityPreferences(this.filePath)
      this.loadFailure = undefined
    } catch (error) {
      this.loadFailure = { error }
      throw error
    }
  }

  get(): Promise<CapabilityPreferences> {
    return this.enqueue(async () => {
      await this.load(true)
      return clone(this.preferences!)
    })
  }

  getSnapshot(): CapabilityPreferences | undefined {
    return this.preferences ? clone(this.preferences) : undefined
  }

  onChanged(listener: (prefs: CapabilityPreferences) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async update(
    expectedRevision: number, change: CapabilityChange, items: readonly CapabilityItem[], assertCurrent: () => void = () => undefined
  ): Promise<CapabilityPreferences> {
    if (!validRevision(expectedRevision)) invalid('能力开关设置修订号无效')
    const captured = captureChange(change, items)
    return this.enqueue(async () => {
      assertCurrent()
      await this.load()
      assertCurrent()
      if (this.preferences!.revision !== expectedRevision) invalid('能力开关设置已变更，请刷新后重试')
      const next = applyChange(this.preferences!, captured)
      if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`, 'utf8') > MAX_FILE_BYTES) invalid('能力开关设置超过 256 KiB')
      try { await writeAtomicJson(this.filePath, next, assertCurrent) }
      catch { invalid('能力开关设置保存失败') }
      try { assertCurrent() }
      catch {
        this.preferences = undefined
        this.loadFailure = undefined
        invalid('能力开关设置已写入，但所属窗口已变更，请重新读取')
      }
      this.preferences = next
      for (const listener of [...this.listeners]) {
        try { listener(clone(next)) } catch { /* A listener cannot turn a committed write into a failure. */ }
      }
      return clone(next)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Capability settings are closed'))
    const result = this.operations.then(operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  /** Close admission and wait for actual reads, writes and staging cleanup. */
  shutdown(): Promise<void> {
    this.closed = true
    return this.operations
  }
}
