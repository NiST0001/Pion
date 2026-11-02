import { constants } from 'node:fs'
import type * as Fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { vi } from 'vitest'

/** Test-only POSIX directory sync model for explicitly registered fixture directories.
 * File IO stays real. Model success provides no Windows durability evidence.
 */
export function createUsageLedgerDirectoryIo() {
  const directories = new Set<string>()
  const handles: { sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  return {
    register(path: string) { directories.add(resolve(path)) },
    reset() { directories.clear(); handles.length = 0 },
    handles,
    open(actual: typeof Fs) {
      const open: typeof Fs.open = async (path, flags, mode) => {
        if (process.platform === 'win32' && typeof path === 'string' && directories.has(resolve(path))
          && flags === (constants.O_RDONLY | constants.O_NOFOLLOW) && mode === undefined) {
          const stat = await actual.lstat(path)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('fixture directory changed')
          let closed = false
          const sync = vi.fn(async () => { if (closed) throw new Error('directory handle closed') })
          const close = vi.fn(async () => {
            if (closed) throw new Error('directory handle already closed')
            closed = true
          })
          handles.push({ sync, close })
          return { sync, close } as unknown as Awaited<ReturnType<typeof Fs.open>>
        }
        return actual.open(path, flags, mode)
      }
      return open
    }
  }
}
