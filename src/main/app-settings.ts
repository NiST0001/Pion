import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'

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
  sessionModels?: Record<string, SessionModelPreference>
}

const DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED = true

/** Persistent settings owned by the Pion shell rather than by a pi session. */
export class AppSettings implements SessionModelPreferenceStore {
  private settings: PionSettingsFile = {}
  private writeQueue: Promise<void> = Promise.resolve()

  private get filePath(): string {
    return join(app.getPath('userData'), 'pion-settings.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        if (typeof record.windowEffectsEnabled === 'boolean') this.settings.windowEffectsEnabled = record.windowEffectsEnabled
        const value = record.completionNotificationsEnabled
        if (typeof value === 'boolean') this.settings.completionNotificationsEnabled = value
        if (typeof record.sessionModels === 'object' && record.sessionModels !== null) {
          const sessionModels: Record<string, SessionModelPreference> = {}
          for (const [path, candidate] of Object.entries(record.sessionModels)) {
            if (typeof candidate !== 'object' || candidate === null) continue
            const preference = candidate as Record<string, unknown>
            if (
              typeof preference.provider === 'string'
              && preference.provider.length > 0
              && typeof preference.modelId === 'string'
              && preference.modelId.length > 0
            ) {
              sessionModels[resolve(path)] = {
                provider: preference.provider,
                modelId: preference.modelId
              }
            }
          }
          this.settings.sessionModels = sessionModels
        }
      }
    } catch {
      // Missing or malformed shell settings fall back to safe defaults.
    }
  }

  get windowEffectsEnabled(): boolean { return this.settings.windowEffectsEnabled ?? false }

  async setWindowEffectsEnabled(enabled: boolean): Promise<void> {
    const previous = this.settings.windowEffectsEnabled
    this.settings = { ...this.settings, windowEffectsEnabled: enabled }
    try { await this.persist() } catch (error) {
      this.settings = { ...this.settings, windowEffectsEnabled: previous }
      throw error
    }
  }

  get completionNotificationsEnabled(): boolean {
    return this.settings.completionNotificationsEnabled
      ?? DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED
  }

  async setCompletionNotificationsEnabled(enabled: boolean): Promise<void> {
    this.settings = { ...this.settings, completionNotificationsEnabled: enabled }
    await this.persist()
  }

  getSessionModel(sessionPath: string): SessionModelPreference | undefined {
    const preference = this.settings.sessionModels?.[resolve(sessionPath)]
    return preference ? { ...preference } : undefined
  }

  async setSessionModel(
    sessionPath: string,
    preference: SessionModelPreference
  ): Promise<void> {
    const path = resolve(sessionPath)
    const current = this.settings.sessionModels?.[path]
    if (current?.provider === preference.provider && current.modelId === preference.modelId) return
    this.settings = {
      ...this.settings,
      sessionModels: {
        ...this.settings.sessionModels,
        [path]: { ...preference }
      }
    }
    await this.persist()
  }

  async deleteSessionModel(sessionPath: string): Promise<void> {
    const path = resolve(sessionPath)
    if (!this.settings.sessionModels?.[path]) return
    const sessionModels = { ...this.settings.sessionModels }
    delete sessionModels[path]
    this.settings = { ...this.settings, sessionModels }
    await this.persist()
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.settings, null, 2)}\n`
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, snapshot, 'utf8')
      })
    this.writeQueue = write
    return write
  }
}
