import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_QUESTION_SETTINGS, QUESTION_SETTINGS_MAX_BYTES, validateQuestionSettings, type QuestionSettings } from '../shared/question-settings'
import { writeAtomicJson } from './atomic-json-file'

export function questionSettingsFilePath(): string { return join(app.getPath('userData'), 'pion-questions.json') }
export function assertQuestionSettingsOwner(event: Electron.IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (event.sender.id !== ownerId || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) {
    throw new Error('只允许所属主窗口操作 AI 提问设置')
  }
}

/** Deadlines stop waiting, not disk operations. Actual pending retains its slot. */
export class QuestionSettingsStore {
  private reading: Promise<QuestionSettings> | undefined
  private writing = false
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly path: () => string = questionSettingsFilePath) {}

  private wait<T>(operation: Promise<T>, onTimeout: () => void = () => undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error('AI 提问设置操作超时，请稍后重新打开设置')) }, 5000)
    })]).finally(() => clearTimeout(timer))
  }

  private async read(path: string): Promise<QuestionSettings> {
    let file
    try { file = await open(path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_QUESTION_SETTINGS }
      throw error
    }
    try {
      const buffer = Buffer.alloc(QUESTION_SETTINGS_MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > QUESTION_SETTINGS_MAX_BYTES) throw new Error('AI 提问设置文件过大')
      return validateQuestionSettings(JSON.parse(buffer.subarray(0, length).toString('utf8')))
    } finally { await file.close() }
  }

  get(): Promise<QuestionSettings> {
    if (this.closed) return Promise.reject(new Error('Question settings are closed'))
    // A read accepted after a save observes that save, not an older shared read.
    if (this.writing) return this.wait(this.enqueue(() => this.read(this.path())))
    if (!this.reading) {
      const pending = this.enqueue(() => this.read(this.path()))
      this.reading = pending
      const clear = () => { if (this.reading === pending) this.reading = undefined }
      void pending.then(clear, clear)
    }
    return this.wait(this.reading).then((value) => ({ ...value }))
  }

  set(value: unknown, assertCurrent: () => void = () => undefined): Promise<QuestionSettings> {
    const settings = validateQuestionSettings(value)
    if (this.closed) return Promise.reject(new Error('Question settings are closed'))
    if (this.writing) return Promise.reject(new Error('AI 提问设置仍在保存，请稍后重试'))
    this.writing = true
    let expired = false
    const operation = this.enqueue(async () => {
      const path = this.path()
      const current = () => { if (expired) throw new Error('AI 提问设置保存已超时'); assertCurrent() }
      current()
      await this.read(path)
      current()
      await writeAtomicJson(path, settings, current)
      current()
      return { ...settings }
    })
    void operation.then(() => { this.writing = false }, () => { this.writing = false })
    return this.wait(operation, () => { expired = true })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Question settings are closed'))
    const result = this.operations.then(operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  /** UI deadlines leave actual FS operations in the shutdown drain. */
  shutdown(): Promise<void> {
    this.closed = true
    return this.operations
  }
}
