import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SUBAGENT_SETTINGS, validateSubagentSettings, type SubagentSettings } from '../shared/subagents'
import { writeAtomicJson } from './atomic-json-file'

export function subagentSettingsFilePath(): string {
  return join(app.getPath('userData'), 'pion-subagents.json')
}

export function assertSubagentSettingsOwner(event: Electron.IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (event.sender.id !== ownerId || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('只允许所属主窗口操作子代理设置')
  }
}

/** Serialize reads with atomic replacement so later batches observe accepted saves. */
export class SubagentSettingsStore {
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly path: () => string = subagentSettingsFilePath) {}

  private async read(path: string): Promise<SubagentSettings> {
    let raw: string
    try { raw = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateSubagentSettings(DEFAULT_SUBAGENT_SETTINGS)
      throw error
    }
    return validateSubagentSettings(JSON.parse(raw))
  }

  get(): Promise<SubagentSettings> {
    return this.enqueue(() => this.read(this.path()))
  }

  set(value: unknown): Promise<SubagentSettings> {
    // Capture nested identities before waiting for any earlier operation.
    const settings = validateSubagentSettings(value)
    return this.enqueue(async () => {
      const path = this.path()
      // Ordinary save requires a valid source; only a missing file initializes defaults.
      await this.read(path)
      await writeAtomicJson(path, settings)
      return validateSubagentSettings(settings)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Subagent settings are closed'))
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
