import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

interface PionSettingsFile {
  completionNotificationsEnabled?: boolean
}

const DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED = true

/** Persistent settings owned by the Pion shell rather than by a pi session. */
export class AppSettings {
  private settings: PionSettingsFile = {}

  private get filePath(): string {
    return join(app.getPath('userData'), 'pion-settings.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>).completionNotificationsEnabled
        if (typeof value === 'boolean') this.settings.completionNotificationsEnabled = value
      }
    } catch {
      // Missing or malformed shell settings fall back to safe defaults.
    }
  }

  get completionNotificationsEnabled(): boolean {
    return this.settings.completionNotificationsEnabled
      ?? DEFAULT_COMPLETION_NOTIFICATIONS_ENABLED
  }

  async setCompletionNotificationsEnabled(enabled: boolean): Promise<void> {
    this.settings = { ...this.settings, completionNotificationsEnabled: enabled }
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8')
  }
}
