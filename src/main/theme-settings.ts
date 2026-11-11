import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { isThemeId, type ThemeId } from '../shared/theme'
import { writeAtomicJson } from './atomic-json-file'

export function assertThemeSettingsOwner(event: Electron.IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (event.sender.id !== ownerId || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('只允许所属主窗口操作主题设置')
  }
}

/** Separate from both Chromium cache and application files replaced by installs.
 * Older application versions cannot erase this key when saving other settings. */
export class ThemeSettingsStore {
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly path: () => string = () => join(app.getPath('userData'), 'pion-theme.json')) {}

  private async read(path: string): Promise<ThemeId | null> {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!isThemeId(value)) throw new Error('主题配置无效')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  get(): Promise<ThemeId | null> {
    return this.enqueue(() => this.read(this.path()))
  }

  set(value: unknown, assertCurrent: () => void = () => undefined): Promise<ThemeId> {
    if (!isThemeId(value)) throw new Error('主题参数无效')
    return this.enqueue(async () => {
      assertCurrent()
      const path = this.path()
      await this.read(path)
      await writeAtomicJson(path, value, assertCurrent)
      assertCurrent()
      return value
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Theme settings are closed'))
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
