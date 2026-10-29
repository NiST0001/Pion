import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Publish a complete, closed sibling file; callers commit their cache afterwards. */
export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(file)}.tmp-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  let closed = false
  try {
    try {
      await handle.writeFile(json, 'utf8')
      await handle.sync()
    } finally {
      // Wait for the actual close; a failed close retains its private staging file.
      await handle.close()
      closed = true
    }
    await rename(temporary, file)
  } catch (error) {
    if (closed) {
      try { await unlink(temporary) } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `JSON staging cleanup failed: ${temporary}`)
      }
    }
    throw error
  }
}
