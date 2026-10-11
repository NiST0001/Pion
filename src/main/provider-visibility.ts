import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_FILE_BYTES = 64 * 1024
const MAX_PROVIDERS = 256
const MAX_PROVIDER_ID_LENGTH = 128

function validProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_ID_LENGTH && /^[a-z0-9][a-z0-9._-]*(?![\s\S])/.test(value)
}

function parseDisabledProviders(value: unknown): Set<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提供商显示设置无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'version') || !Object.hasOwn(record, 'disabledProviderIds') || record.version !== 1 ||
      !Array.isArray(record.disabledProviderIds) || record.disabledProviderIds.length > MAX_PROVIDERS ||
      !record.disabledProviderIds.every(validProviderId)) {
    throw new Error('提供商显示设置无效')
  }
  return new Set(record.disabledProviderIds)
}

/** Pion-owned display preferences only: never modifies SDK models, credentials or sessions. */
export class ProviderVisibilityStore {
  private loadPromise: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()
  private disabled = new Set<string>()
  private revision = 0

  constructor(private readonly filePath: string) {}

  getRevision(): number { return this.revision }
  get disabledProviderIds(): readonly string[] { return [...this.disabled].sort() }

  // Deliberately return the actual operation promise, including after failure: a
  // failed read must not let a later write replace an unreadable configuration.
  load(): Promise<void> {
    this.loadPromise ??= this.readSettings()
    return this.loadPromise
  }

  private async readSettings(): Promise<void> {
    let handle
    try {
      handle = await open(this.filePath, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.revision++
      return
    }
    let next: Set<string>
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('提供商显示设置文件无效或超过 64 KiB')
      // Fixed-size reads also bound a file growing after stat; never readFile an
      // untrusted settings file before checking its size.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > MAX_FILE_BYTES) throw new Error('提供商显示设置文件超过 64 KiB')
      next = parseDisabledProviders(JSON.parse(buffer.subarray(0, length).toString('utf8')))
    } finally {
      await handle.close()
    }
    this.disabled = next
    this.revision++
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!validProviderId(providerId) || typeof enabled !== 'boolean') throw new Error('提供商显示参数无效')
    const write = this.writes.catch(() => undefined).then(async () => {
      await this.load()
      if (this.disabled.has(providerId) === !enabled) return
      const next = new Set(this.disabled)
      if (enabled) next.delete(providerId)
      else next.add(providerId)
      if (next.size > MAX_PROVIDERS) throw new Error('隐藏的提供商数量超过上限')
      await this.save(next)
      this.disabled = next
      this.revision++
    })
    this.writes = write
    await write
  }

  private async save(disabled: Set<string>): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await mkdir(dirname(this.filePath), { recursive: true })
    // Only clean up a file after our exclusive open succeeded.
    const handle = await open(temporary, 'wx', 0o600)
    let closed = false
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, disabledProviderIds: [...disabled].sort() })}\n`, 'utf8')
      await handle.sync()
      closed = true
      await handle.close()
      await rename(temporary, this.filePath)
    } finally {
      if (!closed) await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  async filterModels<T extends { provider: string }>(models: T[]): Promise<T[]> {
    await this.load()
    await this.writes.catch(() => undefined)
    return models.filter((model) => !this.disabled.has(model.provider))
  }

  async projectProviders<T extends { id: string }>(providers: T[]): Promise<Array<T & { enabled: boolean }>> {
    await this.load()
    await this.writes.catch(() => undefined)
    return providers.map((provider) => ({ ...provider, enabled: !this.disabled.has(provider.id) }))
  }
}
