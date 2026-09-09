import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { DEFAULT_SUBAGENT_SETTINGS, validateSubagentSettings, type SubagentSettings } from '../shared/subagents'

export function subagentSettingsFilePath(): string {
  return join(app.getPath('userData'), 'pion-subagents.json')
}

export function assertSubagentSettingsOwner(event: Electron.IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (event.sender.id !== ownerId || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('只允许所属主窗口操作子代理设置')
  }
}

/** Atomic replacement lets every backend read one complete version per batch. */
export class SubagentSettingsStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: () => string = subagentSettingsFilePath) {}

  async get(): Promise<SubagentSettings> {
    try { return validateSubagentSettings(JSON.parse(await readFile(this.path(), { encoding: 'utf8', signal: AbortSignal.timeout(5000) }))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SUBAGENT_SETTINGS }
      throw error
    }
  }

  set(value: unknown): Promise<SubagentSettings> {
    const settings = validateSubagentSettings(value)
    const write = this.writes.catch(() => undefined).then(async () => {
      const path = this.path()
      const temporary = `${path}.${randomUUID()}.tmp`
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, path)
      } finally { await unlink(temporary).catch(() => undefined) }
      return { ...settings }
    })
    this.writes = write
    return write
  }
}
