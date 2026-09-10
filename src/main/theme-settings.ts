import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { isThemeId, type ThemeId } from '../shared/theme'

export function assertThemeSettingsOwner(event: Electron.IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (event.sender.id !== ownerId || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('只允许所属主窗口操作主题设置')
  }
}

/** Separate from both Chromium cache and application files replaced by installs.
 * Older application versions cannot erase this key when saving other settings. */
export class ThemeSettingsStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: () => string = () => join(app.getPath('userData'), 'pion-theme.json')) {}

  async get(): Promise<ThemeId | null> {
    await this.writes.catch(() => undefined)
    try {
      const value: unknown = JSON.parse(await readFile(this.path(), { encoding: 'utf8', signal: AbortSignal.timeout(5000) }))
      if (!isThemeId(value)) throw new Error('主题配置无效')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  set(value: unknown): Promise<ThemeId> {
    if (!isThemeId(value)) throw new Error('主题参数无效')
    const write = this.writes.catch(() => undefined).then(async () => {
      const path = this.path()
      const temporary = `${path}.${randomUUID()}.tmp`
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, path)
      } finally { await unlink(temporary).catch(() => undefined) }
      return value
    })
    this.writes = write
    return write
  }
}
