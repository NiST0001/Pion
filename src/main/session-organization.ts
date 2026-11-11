import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { writeAtomicJson } from './atomic-json-file'
import {
  applyValidatedSessionOrganizationChange,
  validateSessionOrganization,
  validateSessionOrganizationChange,
  type SessionOrganization
} from '../shared/session-organization'

/** One serial queue covers reads, publication and temporary-file cleanup.
 * The only filesystem target comes from the trusted constructor, never a placement. */
export class SessionOrganizationStore {
  private pending: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(private readonly path: () => string = () => join(app.getPath('userData'), 'pion-session-organization.json')) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('应用正在退出，会话整理已停止接收新操作。'))
    const result = this.pending.then(operation, operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(path: string): Promise<SessionOrganization> {
    let content: string
    try { content = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, folders: [], sessions: [] }
      throw error
    }
    return validateSessionOrganization(JSON.parse(content))
  }

  get(): Promise<SessionOrganization> {
    return this.serial(() => this.read(this.path()))
  }

  shutdown(): Promise<void> {
    this.closing = true
    return this.pending.then(() => undefined)
  }

  async update(input: unknown, assertCurrent: () => void = () => {}): Promise<SessionOrganization> {
    // Capture the patch before it waits behind another filesystem transaction.
    const change = validateSessionOrganizationChange(input)
    return this.serial(async () => {
      assertCurrent()
      const path = this.path()
      const current = await this.read(path)
      assertCurrent()
      const next = applyValidatedSessionOrganizationChange(current, change)
      assertCurrent()
      await writeAtomicJson(path, next, assertCurrent)
      assertCurrent()
      return next
    })
  }
}
