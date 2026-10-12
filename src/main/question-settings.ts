import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { DEFAULT_QUESTION_SETTINGS, QUESTION_SETTINGS_MAX_BYTES, validateQuestionSettings, type QuestionSettings } from '../shared/question-settings'

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
  constructor(private readonly path: () => string = questionSettingsFilePath) {}

  private wait<T>(operation: Promise<T>, onTimeout: () => void = () => undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error('AI 提问设置操作超时，请稍后重新打开设置')) }, 5000)
    })]).finally(() => clearTimeout(timer))
  }

  get(): Promise<QuestionSettings> {
    if (!this.reading) {
      const pending = (async () => {
        try {
          const file = await open(this.path(), 'r')
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
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_QUESTION_SETTINGS }
          throw error
        }
      })()
      this.reading = pending
      const clear = () => { if (this.reading === pending) this.reading = undefined }
      void pending.then(clear, clear)
    }
    return this.wait(this.reading).then((value) => ({ ...value }))
  }

  set(value: unknown, assertCurrent: () => void = () => undefined): Promise<QuestionSettings> {
    const settings = validateQuestionSettings(value)
    if (this.writing) return Promise.reject(new Error('AI 提问设置仍在保存，请稍后重试'))
    this.writing = true
    let expired = false
    const operation = (async () => {
      const path = this.path()
      const temporary = `${path}.${randomUUID()}.tmp`
      const current = () => { if (expired) throw new Error('AI 提问设置保存已超时'); assertCurrent() }
      try {
        current()
        await mkdir(dirname(path), { recursive: true })
        current()
        await writeFile(temporary, `${JSON.stringify(settings)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        current()
        await rename(temporary, path)
        return { ...settings }
      } finally { await unlink(temporary).catch(() => undefined) }
    })()
    void operation.then(() => { this.writing = false }, () => { this.writing = false })
    return this.wait(operation, () => { expired = true })
  }
}
