import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { writeAtomicJson } from './atomic-json-file'

export interface SessionModelPreference {
  provider: string
  modelId: string
}

export interface SessionModelPreferenceStore {
  getSessionModel(sessionPath: string): SessionModelPreference | undefined
  setSessionModel(sessionPath: string, preference: SessionModelPreference, assertCurrent?: () => void): Promise<void>
  deleteSessionModel(sessionPath: string, assertCurrent?: () => void): Promise<void>
}

interface PionSettingsFile {
  windowEffectsEnabled?: boolean
  completionNotificationsEnabled?: boolean
  usageBackgroundCollectionEnabled?: boolean
  sessionModels?: Record<string, SessionModelPreference>
}

const DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED = true

function parseSettings(value: unknown): PionSettingsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Pion settings file')
  }
  const record = value as Record<string, unknown>
  for (const key of ['windowEffectsEnabled', 'completionNotificationsEnabled', 'usageBackgroundCollectionEnabled']) {
    if (Object.hasOwn(record, key) && typeof record[key] !== 'boolean') throw new Error(`Invalid Pion setting: ${key}`)
  }
  const settings = Object.assign(Object.create(null), record) as PionSettingsFile
  if (Object.hasOwn(record, 'sessionModels')) {
    if (typeof record.sessionModels !== 'object' || record.sessionModels === null || Array.isArray(record.sessionModels)) {
      throw new Error('Invalid Pion session model preferences')
    }
    const sessionModels: Record<string, SessionModelPreference> = Object.create(null)
    for (const [path, candidate] of Object.entries(record.sessionModels)) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('Invalid Pion session model preference')
      }
      const preference = candidate as Record<string, unknown>
      if (!Object.hasOwn(preference, 'provider') || !Object.hasOwn(preference, 'modelId')
        || typeof preference.provider !== 'string' || preference.provider.length === 0
        || typeof preference.modelId !== 'string' || preference.modelId.length === 0) {
        throw new Error('Invalid Pion session model preference')
      }
      sessionModels[resolve(path)] = { ...preference, provider: preference.provider, modelId: preference.modelId }
    }
    settings.sessionModels = sessionModels
  }
  return settings
}

/** Persistent settings owned by the Pion shell rather than by a pi session. */
export class AppSettings implements SessionModelPreferenceStore {
  private settings: PionSettingsFile = Object.create(null)
  private loaded = false
  private closed = false
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly filePath = join(app.getPath('userData'), 'pion-settings.json')

  load(): Promise<void> {
    return this.enqueue(() => this.ensureLoaded())
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }
    this.settings = parseSettings(JSON.parse(raw))
    this.loaded = true
  }

  get windowEffectsEnabled(): boolean { return this.settings.windowEffectsEnabled ?? false }

  setWindowEffectsEnabled(enabled: boolean, assertCurrent?: () => void): Promise<void> {
    return this.update((settings) => ({ ...settings, windowEffectsEnabled: enabled }), assertCurrent)
  }

  get usageBackgroundCollectionEnabled(): boolean {
    return this.settings.usageBackgroundCollectionEnabled ?? true
  }

  setUsageBackgroundCollectionEnabled(enabled: boolean, assertCurrent?: () => void): Promise<void> {
    return this.update((settings) => ({ ...settings, usageBackgroundCollectionEnabled: enabled }), assertCurrent)
  }

  get completionNotificationsEnabled(): boolean {
    return this.settings.completionNotificationsEnabled
      ?? DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED
  }

  setCompletionNotificationsEnabled(enabled: boolean, assertCurrent?: () => void): Promise<void> {
    return this.update((settings) => ({ ...settings, completionNotificationsEnabled: enabled }), assertCurrent)
  }

  getSessionModel(sessionPath: string): SessionModelPreference | undefined {
    const models = this.settings.sessionModels
    const path = resolve(sessionPath)
    const preference = models && Object.hasOwn(models, path) ? models[path] : undefined
    return preference ? { ...preference } : undefined
  }

  async setSessionModel(sessionPath: string, preference: SessionModelPreference, assertCurrent?: () => void): Promise<void> {
    const path = resolve(sessionPath)
    const next = { ...preference }
    return this.update((settings) => {
      const current = settings.sessionModels && Object.hasOwn(settings.sessionModels, path) ? settings.sessionModels[path] : undefined
      if (current?.provider === next.provider && current.modelId === next.modelId) return settings
      return { ...settings, sessionModels: Object.assign(Object.create(null), settings.sessionModels, { [path]: next }) }
    }, assertCurrent)
  }

  async deleteSessionModel(sessionPath: string, assertCurrent?: () => void): Promise<void> {
    const path = resolve(sessionPath)
    return this.update((settings) => {
      if (!settings.sessionModels || !Object.hasOwn(settings.sessionModels, path)) return settings
      const sessionModels = Object.assign(Object.create(null), settings.sessionModels) as Record<string, SessionModelPreference>
      delete sessionModels[path]
      return { ...settings, sessionModels }
    }, assertCurrent)
  }

  private update(patch: (settings: PionSettingsFile) => PionSettingsFile, assertCurrent: () => void = () => undefined): Promise<void> {
    return this.enqueue(async () => {
      assertCurrent()
      await this.ensureLoaded()
      assertCurrent()
      const next = patch(this.settings)
      if (next === this.settings) return
      await writeAtomicJson(this.filePath, next, assertCurrent)
      this.settings = next
      assertCurrent()
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Pion settings are closed'))
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.catch(() => undefined)
    return result
  }

  /** Close admission and await every accepted load/write, including staging cleanup. */
  shutdown(): Promise<void> {
    this.closed = true
    return this.writeQueue
  }
}
