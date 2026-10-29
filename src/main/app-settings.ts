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
  setSessionModel(sessionPath: string, preference: SessionModelPreference): Promise<void>
  deleteSessionModel(sessionPath: string): Promise<void>
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
    if (key in record && typeof record[key] !== 'boolean') throw new Error(`Invalid Pion setting: ${key}`)
  }
  const settings = { ...record } as PionSettingsFile
  if ('sessionModels' in record) {
    if (typeof record.sessionModels !== 'object' || record.sessionModels === null || Array.isArray(record.sessionModels)) {
      throw new Error('Invalid Pion session model preferences')
    }
    const sessionModels: Record<string, SessionModelPreference> = {}
    for (const [path, candidate] of Object.entries(record.sessionModels)) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('Invalid Pion session model preference')
      }
      const preference = candidate as Record<string, unknown>
      if (typeof preference.provider !== 'string' || preference.provider.length === 0
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
  private settings: PionSettingsFile = {}
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

  setWindowEffectsEnabled(enabled: boolean): Promise<void> {
    return this.update((settings) => ({ ...settings, windowEffectsEnabled: enabled }))
  }

  get usageBackgroundCollectionEnabled(): boolean {
    return this.settings.usageBackgroundCollectionEnabled ?? true
  }

  setUsageBackgroundCollectionEnabled(enabled: boolean): Promise<void> {
    return this.update((settings) => ({ ...settings, usageBackgroundCollectionEnabled: enabled }))
  }

  get completionNotificationsEnabled(): boolean {
    return this.settings.completionNotificationsEnabled
      ?? DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED
  }

  setCompletionNotificationsEnabled(enabled: boolean): Promise<void> {
    return this.update((settings) => ({ ...settings, completionNotificationsEnabled: enabled }))
  }

  getSessionModel(sessionPath: string): SessionModelPreference | undefined {
    const preference = this.settings.sessionModels?.[resolve(sessionPath)]
    return preference ? { ...preference } : undefined
  }

  async setSessionModel(sessionPath: string, preference: SessionModelPreference): Promise<void> {
    const path = resolve(sessionPath)
    const next = { ...preference }
    return this.update((settings) => {
      const current = settings.sessionModels?.[path]
      if (current?.provider === next.provider && current.modelId === next.modelId) return settings
      return { ...settings, sessionModels: { ...settings.sessionModels, [path]: next } }
    })
  }

  async deleteSessionModel(sessionPath: string): Promise<void> {
    const path = resolve(sessionPath)
    return this.update((settings) => {
      if (!settings.sessionModels?.[path]) return settings
      const sessionModels = { ...settings.sessionModels }
      delete sessionModels[path]
      return { ...settings, sessionModels }
    })
  }

  private update(patch: (settings: PionSettingsFile) => PionSettingsFile): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      const next = patch(this.settings)
      if (next === this.settings) return
      await writeAtomicJson(this.filePath, next)
      this.settings = next
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
