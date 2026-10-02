import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  readImageReferences, type ImageInputFileHandle, type ImageInputFileStat,
  type ImageInputFileSystem, type ImageReferenceRoot
} from '../../src/main/agent/image-inputs'
import * as transport from '../../src/main/agent/codex-image-transport'
import {
  MAX_IMAGE_REFERENCE_BYTES, MAX_IMAGE_REFERENCE_TOTAL_BYTES, MAX_IMAGE_REFERENCE_TOTAL_PIXELS,
  MAX_IMAGE_REQUEST_DIMENSION
} from '../../src/shared/image-generation'
import { makeStaticPng } from '../fixtures/static-png'

const cwd = resolve('/pion-reference-project')
const png = makeStaticPng()
const privateDiagnostic = '/private/account/auth.json Bearer sk-private-content https://private.invalid/image'
const quarantineMessage = '参考图片文件句柄关闭未能确认，本进程参考图片读取已隔离，请重建后端后再试。 尚未上传任何参考图片。'
const fileError = (code: string) => Object.assign(new Error(privateDiagnostic), { code })
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function drain() { for (let index = 0; index < 40; index++) await Promise.resolve() }

// A failed close has no production reset. Keep each quarantine test's module
// private, without changing the static reader used by other tests/suites or
// leaving the quarantined instance in the dynamic-import cache.
async function isolatedReader(): Promise<typeof readImageReferences> {
  vi.resetModules()
  try { return (await import('../../src/main/agent/image-inputs')).readImageReferences }
  finally { vi.resetModules() }
}

function segment(marker: number, payload: Uint8Array): Buffer {
  const bytes = Buffer.alloc(payload.length + 4)
  bytes.set([0xff, marker])
  bytes.writeUInt16BE(payload.length + 2, 2)
  bytes.set(payload, 4)
  return bytes
}
/** A minimal grayscale baseline stream: quantizer, DC-zero/EOB Huffman tables,
 * SOF/SOS, entropy, and EOI. Dimension variants exercise structural admission,
 * not full entropy decoding of a resized image; no decoder is invoked here. */
function jpeg(width = 1, height = 1, byteLength?: number): Buffer {
  const quantizer = new Uint8Array(65).fill(1)
  quantizer[0] = 0
  const huffman = (selector: number) => {
    const table = new Uint8Array(18)
    table[0] = selector
    table[1] = 1
    return table
  }
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  const parts = [
    segment(0xdb, quantizer), segment(0xc4, huffman(0)), segment(0xc4, huffman(0x10)),
    segment(0xc0, frame), segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Buffer.from([0x3f, 0xff, 0xd9])
  ]
  let remaining = (byteLength ?? parts.reduce((sum, part) => sum + part.length, 2))
    - parts.reduce((sum, part) => sum + part.length, 2)
  const metadata: Buffer[] = []
  while (remaining > 0) {
    let size = Math.min(65537, remaining)
    if (remaining - size > 0 && remaining - size < 4) size -= 4 - (remaining - size)
    if (size < 4) throw new Error('Invalid synthetic JPEG padding size')
    metadata.push(segment(0xef, new Uint8Array(size - 4)))
    remaining -= size
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...metadata, ...parts])
}

interface Entry {
  kind: 'directory' | 'file' | 'link' | 'special'
  dev: number | bigint
  ino: number | bigint
  bytes: Uint8Array
  size?: number | bigint
  mtimeNs: number | bigint
  ctimeNs: number | bigint
  target?: string
}
type MockHandle = {
  stat: ReturnType<typeof vi.fn<ImageInputFileHandle['stat']>>
  read: ReturnType<typeof vi.fn<ImageInputFileHandle['read']>>
  close: ReturnType<typeof vi.fn<ImageInputFileHandle['close']>>
}
function fakeDisk(reader: typeof readImageReferences = readImageReferences) {
  let nextInode = 1n
  const entries = new Map<string, Entry>()
  const put = (path: string, kind: Entry['kind'], bytes: Uint8Array = new Uint8Array(), target?: string): Entry => {
    const entry: Entry = {
      kind, dev: 1n, ino: nextInode++, bytes,
      mtimeNs: 1_700_000_000_000_000_001n, ctimeNs: 1_700_000_000_000_000_003n, target
    }
    entries.set(resolve(cwd, path), entry)
    return entry
  }
  const rootNode = put(cwd, 'directory')
  const root: ImageReferenceRoot = { cwd, root: cwd, rootIdentity: { dev: rootNode.dev, ino: rootNode.ino } }
  const stat = (node: Entry): ImageInputFileStat => ({
    dev: node.dev, ino: node.ino, size: node.size ?? BigInt(node.bytes.byteLength),
    mtimeNs: node.mtimeNs, ctimeNs: node.ctimeNs,
    isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
    isSymbolicLink: () => node.kind === 'link'
  })
  const handles: MockHandle[] = []
  const state: { onOpen?: (handle: MockHandle, node: Entry, path: string) => void } = {}
  const files = {
    realpath: vi.fn<ImageInputFileSystem['realpath']>(async (path) => {
      const entry = entries.get(path)
      if (!entry) throw fileError('ENOENT')
      return entry.kind === 'link' ? entry.target! : path
    }),
    lstat: vi.fn<ImageInputFileSystem['lstat']>(async (path) => {
      const entry = entries.get(path)
      if (!entry) throw fileError('ENOENT')
      return stat(entry)
    }),
    open: vi.fn<ImageInputFileSystem['open']>(async (path, flags) => {
      if (flags !== (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) throw fileError('EINVAL')
      const node = entries.get(path)
      if (!node) throw fileError('ENOENT')
      const handle: MockHandle = {
        stat: vi.fn<ImageInputFileHandle['stat']>(async () => stat(node)),
        read: vi.fn<ImageInputFileHandle['read']>(async (bytes, offset, length, position) => {
          const count = Math.min(length, Math.max(0, node.bytes.byteLength - position))
          bytes.set(node.bytes.subarray(position, position + count), offset)
          return { bytesRead: count }
        }),
        close: vi.fn<ImageInputFileHandle['close']>(async () => {})
      }
      handles.push(handle)
      state.onOpen?.(handle, node, path)
      return handle
    })
  }
  const read = (paths: readonly string[] = ['reference.png'], abortSignal = signal()) => reader(root, paths, abortSignal, { files })
  put('reference.png', 'file', png)
  return { root, rootNode, read, files, put, entries, handles, state }
}
afterEach(() => vi.restoreAllMocks())

it('returns private ordered PNG/JPEG snapshots, never paths, prompts or provider URLs', async () => {
  const disk = fakeDisk()
  disk.put('photos', 'directory')
  const source = disk.put('photos/portrait.JPEG', 'file', jpeg())
  const references = await disk.read(['./reference.png', 'photos/portrait.JPEG'])
  expect(references).toHaveLength(2)
  expect(references[0]).toEqual({ bytes: new Uint8Array(png), mimeType: 'image/png', width: 1, height: 1 })
  expect(references[1]).toEqual({ bytes: new Uint8Array(source.bytes), mimeType: 'image/jpeg', width: 1, height: 1 })
  for (const reference of references) expect(Object.keys(reference).sort()).toEqual(['bytes', 'height', 'mimeType', 'width'])
  expect(disk.files.open.mock.calls.map(([path, flags]) => [path, flags])).toEqual([
    [resolve(cwd, 'reference.png'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK],
    [resolve(cwd, 'photos/portrait.JPEG'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]
  ])
  expect(disk.handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
  for (const handle of disk.handles) {
    expect(handle.read.mock.calls.at(-1)?.slice(1)).toEqual([0, 1, handle.read.mock.calls[0][0].length])
  }
  expect(references[0].bytes).not.toBe(png)
  expect(references[1].bytes).not.toBe(source.bytes)
  source.bytes = Uint8Array.of(9)
  expect(references[1].bytes).toEqual(new Uint8Array(jpeg()))
  expect(JSON.stringify(references)).not.toContain('photos')
  expect(JSON.stringify(references)).not.toContain(privateDiagnostic)
})

it('permits exactly five references and a captured cwd alias which still maps to its real worktree', async () => {
  const disk = fakeDisk()
  const alias = resolve('/pion-reference-alias')
  disk.put(alias, 'link', undefined, cwd)
  const references = await readImageReferences({ ...disk.root, cwd: alias }, Array(5).fill('reference.png'), signal(), { files: disk.files })
  expect(references).toHaveLength(5)
  expect(disk.files.realpath).toHaveBeenCalledWith(alias)
  expect(disk.handles).toHaveLength(5)
})

it('returns no-input [] without acquiring a slot, validating root, touching disk or requiring a live signal', async () => {
  const disk = fakeDisk()
  const controller = new AbortController()
  controller.abort(new Error(privateDiagnostic))
  expect(await readImageReferences({} as ImageReferenceRoot, [], controller.signal, { files: disk.files })).toEqual([])
  expect(disk.files.realpath).not.toHaveBeenCalled()
  expect(disk.files.lstat).not.toHaveBeenCalled()
  expect(disk.files.open).not.toHaveBeenCalled()
})

it.each([
  null, {}, 'reference.png', false, 4, [undefined], Array(2), Array(6).fill('reference.png'),
  ['../reference.png'], ['/outside.png'], ['C:/outside.png'], ['a\\reference.png'], ['a//reference.png'],
  ['https://private.invalid/reference.png'], ['data:image/png;base64,private'], ['NUL.png'], ['bad.png '],
  ['reference.gif'], ['a/../reference.png'], ['ref\u0000.png'], [`${'x'.repeat(509)}.png`],
  Array(5).fill(`${'abc/'.repeat(31)}${'x'.repeat(251)}.png`)
].map((paths) => ({ paths })))('rejects unknown/malformed reference paths before disk access: $paths', async ({ paths }) => {
  const disk = fakeDisk()
  await expect(disk.read(paths as unknown as readonly string[])).rejects.toThrow(/安全.*尚未上传/)
  expect(disk.files.realpath).not.toHaveBeenCalled()
  expect(disk.files.lstat).not.toHaveBeenCalled()
  expect(disk.files.open).not.toHaveBeenCalled()
})

it('normalizes numeric/bigint identities losslessly, including IDs beyond safe numeric precision', async () => {
  const disk = fakeDisk()
  disk.root.rootIdentity = { dev: 1, ino: 1 }
  expect(await disk.read()).toHaveLength(1)
  const huge = 9_007_199_254_740_995n
  disk.rootNode.ino = huge
  disk.root.rootIdentity = { dev: 1, ino: huge }
  disk.entries.get(resolve(cwd, 'reference.png'))!.ino = huge + 1n
  expect(await disk.read()).toHaveLength(1)
})

it.each([0, 0n, -1, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects unidentifiable captured roots before opening inputs: %s', async (ino) => {
  const disk = fakeDisk()
  disk.root.rootIdentity.ino = ino
  await expect(disk.read()).rejects.toThrow(/身份.*尚未上传/)
  expect(disk.files.open).not.toHaveBeenCalled()
})

it('rejects changed captured root identity and changed cwd/root mappings', async () => {
  const disk = fakeDisk()
  disk.put(cwd, 'directory')
  await expect(disk.read()).rejects.toThrow('项目真实目录')
  expect(disk.files.open).not.toHaveBeenCalled()
  const mapped = fakeDisk()
  mapped.files.realpath.mockResolvedValue(resolve('/other-worktree'))
  await expect(mapped.read()).rejects.toThrow('项目真实目录')
  expect(mapped.files.open).not.toHaveBeenCalled()
})

it.each(['root', 'parent', 'target'])('rejects known %s symlinks before any open', async (where) => {
  const disk = fakeDisk()
  disk.put('photos', 'directory')
  disk.put('photos/reference.png', 'file', png)
  if (where === 'root') { disk.rootNode.kind = 'link'; disk.rootNode.target = cwd }
  if (where === 'parent') disk.put('photos', 'link', undefined, resolve('/outside'))
  if (where === 'target') disk.put('photos/reference.png', 'link', undefined, resolve('/outside/reference.png'))
  await expect(disk.read(['photos/reference.png'])).rejects.toThrow(/目录|符号链接/)
  expect(disk.files.open).not.toHaveBeenCalled()
})

it.each(['directory', 'special'])('rejects a non-regular %s input without opening it', async (kind) => {
  const disk = fakeDisk()
  disk.put('reference.png', kind as Entry['kind'], png)
  await expect(disk.read()).rejects.toThrow(/不是普通文件.*尚未上传/)
  expect(disk.files.open).not.toHaveBeenCalled()
})

it('rejects realpath aliasing under a regular-looking parent or target', async () => {
  const disk = fakeDisk()
  disk.put('photos', 'directory')
  disk.put('photos/reference.png', 'file', png)
  const realpath = disk.files.realpath.getMockImplementation()!
  disk.files.realpath.mockImplementation(async (path) => path === resolve(cwd, 'photos') ? resolve('/outside') : realpath(path))
  await expect(disk.read(['photos/reference.png'])).rejects.toThrow('父目录')
  expect(disk.files.open).not.toHaveBeenCalled()
  disk.files.realpath.mockImplementation(async (path) => path === resolve(cwd, 'photos/reference.png') ? resolve('/outside/reference.png') : realpath(path))
  await expect(disk.read(['photos/reference.png'])).rejects.toThrow('符号链接')
  expect(disk.files.open).not.toHaveBeenCalled()
})

it.each(['root', 'outer-parent', 'inner-parent', 'path'])('detects %s replacement after open even if the pathname is unchanged', async (where) => {
  const disk = fakeDisk()
  disk.put('photos', 'directory')
  disk.put('photos/nested', 'directory')
  disk.put('photos/nested/reference.png', 'file', png)
  disk.state.onOpen = () => {
    if (where === 'root') disk.put(cwd, 'directory')
    else if (where === 'outer-parent') disk.put('photos', 'directory')
    else if (where === 'inner-parent') disk.put('photos/nested', 'directory')
    else disk.put('photos/nested/reference.png', 'file', png)
  }
  await expect(disk.read(['photos/nested/reference.png'])).rejects.toThrow(/变化|目录/)
  expect(disk.handles[0].read).not.toHaveBeenCalled()
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it.each(['root', 'parent', 'path'])('rechecks %s identity after the actual byte reads', async (where) => {
  const disk = fakeDisk()
  disk.put('photos', 'directory')
  disk.put('photos/reference.png', 'file', png)
  disk.state.onOpen = (handle) => {
    const read = handle.read.getMockImplementation()!
    handle.read.mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      if (where === 'root') disk.put(cwd, 'directory')
      else if (where === 'parent') disk.put('photos', 'directory')
      else disk.put('photos/reference.png', 'file', png)
      return result
    })
  }
  await expect(disk.read(['photos/reference.png'])).rejects.toThrow(/变化|目录/)
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it('refuses an FD whose identity differs from the pre-open lstat snapshot', async () => {
  const disk = fakeDisk()
  disk.state.onOpen = (handle, node) => {
    handle.stat.mockImplementation(async () => ({
      dev: node.dev, ino: 999n, size: BigInt(node.bytes.length), mtimeNs: node.mtimeNs, ctimeNs: node.ctimeNs,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false
    }))
  }
  await expect(disk.read()).rejects.toThrow('文件快照')
  expect(disk.handles[0].read).not.toHaveBeenCalled()
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])('rejects changed post-read FD snapshot field %s', async (field) => {
  const disk = fakeDisk()
  disk.state.onOpen = (handle, node) => {
    const read = handle.read.getMockImplementation()!
    handle.read.mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      if (field === 'size') node.size = BigInt(node.bytes.byteLength + 1)
      else if (field === 'dev') node.dev = 2n
      else if (field === 'ino') node.ino = 999n
      else if (field === 'mtimeNs') node.mtimeNs = BigInt(node.mtimeNs) + 1n
      else node.ctimeNs = BigInt(node.ctimeNs) + 1n
      return result
    })
  }
  await expect(disk.read()).rejects.toThrow('文件快照')
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it.each([0, 0n, -1n, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, BigInt(MAX_IMAGE_REFERENCE_BYTES) + 1n])('rejects invalid/over-budget file sizes before opening: %s', async (size) => {
  const disk = fakeDisk()
  disk.entries.get(resolve(cwd, 'reference.png'))!.size = size
  await expect(disk.read()).rejects.toThrow(/每张最多 8 MiB.*尚未上传/)
  expect(disk.files.open).not.toHaveBeenCalled()
})

it.each(['dev', 'ino', 'mtimeNs', 'ctimeNs'])('fails closed when file snapshot %s is missing or unusable', async (field) => {
  const disk = fakeDisk()
  const entry = disk.entries.get(resolve(cwd, 'reference.png'))!
  if (field === 'dev') entry.dev = 0n
  else if (field === 'ino') entry.ino = 0n
  else if (field === 'mtimeNs') entry.mtimeNs = NaN
  else entry.ctimeNs = Number.MAX_SAFE_INTEGER + 1
  await expect(disk.read()).rejects.toThrow('身份无法确认')
  expect(disk.files.open).not.toHaveBeenCalled()
})

it.each(['growth', 'truncation'])('uses actual bounded reads and an EOF probe to reject %s even with a stale reported size', async (change) => {
  const disk = fakeDisk()
  const entry = disk.entries.get(resolve(cwd, 'reference.png'))!
  entry.size = BigInt(png.length)
  entry.bytes = change === 'growth' ? Buffer.concat([png, Buffer.from([1])]) : png.subarray(0, png.length - 1)
  await expect(disk.read()).rejects.toThrow(/增长或截断.*尚未上传/)
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it.each([undefined, NaN, Infinity, -1, 0, 0.5, png.length + 1])('rejects anomalous read results without returning uninitialized or partial data: %s', async (bytesRead) => {
  const disk = fakeDisk()
  disk.state.onOpen = (handle) => handle.read.mockResolvedValueOnce({ bytesRead } as { bytesRead: number })
  await expect(disk.read()).rejects.toThrow('读取结果异常')
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it('handles short positive reads positionally and never requests more than 64 KiB at once', async () => {
  const disk = fakeDisk()
  const large = jpeg(1, 1, 180_000)
  disk.put('large.jpg', 'file', large)
  disk.state.onOpen = (handle) => {
    const read = handle.read.getMockImplementation()!
    handle.read.mockImplementation((bytes, offset, length, position) => read(bytes, offset, Math.min(length, 25_000), position))
  }
  const [reference] = await disk.read(['large.jpg'])
  expect(reference.bytes).toEqual(new Uint8Array(large))
  expect(disk.handles[0].read.mock.calls.every(([, , length]) => length <= 64 * 1024)).toBe(true)
  expect(disk.handles[0].read.mock.calls.slice(0, -1).every(([, offset, , position]) => offset === position)).toBe(true)
  expect(disk.handles[0].read.mock.calls.at(-1)?.slice(1)).toEqual([0, 1, large.byteLength])
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it('accepts exact 8 MiB per-file / 16 MiB aggregate snapshots, rejecting a third file before its open', async () => {
  const disk = fakeDisk()
  const large = jpeg(1, 1, MAX_IMAGE_REFERENCE_BYTES)
  disk.put('first.jpg', 'file', large)
  disk.put('second.jpg', 'file', large)
  const accepted = await disk.read(['first.jpg', 'second.jpg'])
  expect(accepted.map(({ bytes }) => bytes.byteLength)).toEqual([MAX_IMAGE_REFERENCE_BYTES, MAX_IMAGE_REFERENCE_BYTES])
  expect(accepted.reduce((sum, { bytes }) => sum + bytes.byteLength, 0)).toBe(MAX_IMAGE_REFERENCE_TOTAL_BYTES)
  disk.files.open.mockClear()
  await expect(disk.read(['first.jpg', 'second.jpg', 'reference.png'])).rejects.toThrow('合计最多 16 MiB')
  expect(disk.files.open).toHaveBeenCalledTimes(2)
  expect(disk.handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
})

it('enforces the 4096-pixel dimension boundary and exact 16M total-pixel boundary', async () => {
  const disk = fakeDisk()
  disk.put('edge.png', 'file', makeStaticPng(MAX_IMAGE_REQUEST_DIMENSION, 1))
  disk.put('edge.jpg', 'file', jpeg(MAX_IMAGE_REQUEST_DIMENSION, 1))
  expect(await disk.read(['edge.png', 'edge.jpg'])).toMatchObject([
    { mimeType: 'image/png', width: 4096, height: 1 },
    { mimeType: 'image/jpeg', width: 4096, height: 1 }
  ])
  disk.put('over.jpg', 'file', jpeg(MAX_IMAGE_REQUEST_DIMENSION + 1, 1))
  await expect(disk.read(['over.jpg'])).rejects.toThrow('尺寸')
  disk.put('eight.jpg', 'file', jpeg(4000, 2000))
  const exact = await disk.read(['eight.jpg', 'eight.jpg'])
  expect(exact.reduce((sum, { width, height }) => sum + width * height, 0)).toBe(MAX_IMAGE_REFERENCE_TOTAL_PIXELS)
  await expect(disk.read(['eight.jpg', 'eight.jpg', 'reference.png'])).rejects.toThrow('累计像素')
})

it('checks the remaining cumulative pixel budget before invoking PNG integrity/inflate', async () => {
  const disk = fakeDisk()
  disk.put('first.jpg', 'file', jpeg(4096, 3000))
  // Framing is valid, but the deliberately inconsistent PNG raster would fail
  // integrity checking. It must never reach that inflate helper over budget.
  const oversized = Buffer.from(png)
  oversized.writeUInt32BE(4096, 16)
  oversized.writeUInt32BE(2048, 20)
  disk.put('over.png', 'file', oversized)
  const inspect = vi.spyOn(transport, 'inspectReferenceImage')
  await expect(disk.read(['first.jpg', 'over.png'])).rejects.toThrow('累计像素')
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(inspect.mock.calls[0][1]).toBe('image/jpeg')
  expect(disk.handles).toHaveLength(2)
  expect(disk.handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
})

it.each(['png-crc', 'png-raster', 'jpeg-eoi', 'jpeg-scan', 'mime'])('rejects malformed or mismatched image data after closing its FD: %s', async (failure) => {
  const disk = fakeDisk()
  let path = 'reference.png'
  let bytes: Buffer = Buffer.from(png)
  if (failure === 'png-crc') bytes[bytes.length - 1] ^= 1
  else if (failure === 'png-raster') {
    bytes.writeUInt32BE(2, 16) // Consistent outer framing, wrong CRC and scanline geometry.
  } else if (failure === 'jpeg-eoi') {
    path = 'reference.jpg'
    bytes = jpeg().subarray(0, -2)
  } else if (failure === 'jpeg-scan') {
    path = 'reference.jpg'
    bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xc0, Uint8Array.of(8, 0, 1, 0, 1, 1, 1, 0x11, 0)), Buffer.from([0xff, 0xd9])])
  } else bytes = jpeg()
  disk.put(path, 'file', bytes)
  await expect(disk.read([path])).rejects.toThrow(/完整性.*尚未上传/)
  expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
})

it.each([
  { flag: 'O_NOFOLLOW', value: undefined, state: 'missing' },
  { flag: 'O_NOFOLLOW', value: 0, state: 'zero' },
  { flag: 'O_NONBLOCK', value: undefined, state: 'missing' },
  { flag: 'O_NONBLOCK', value: 0, state: 'zero' }
] as const)('rejects $state $flag before any filesystem operation', async ({ flag, value }) => {
  // Never spy on or mutate the shared node:fs constants namespace. Give only
  // this freshly imported reader a mock, with the other strict flag positive
  // regardless of the host platform so each fail-closed branch is exercised.
  vi.resetModules()
  try {
    const mockConstants: Record<string, number> = { ...constants, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 }
    if (value === undefined) delete mockConstants[flag]
    else mockConstants[flag] = value
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, constants: mockConstants }
    })
    const reader = (await import('../../src/main/agent/image-inputs')).readImageReferences
    const disk = fakeDisk(reader)
    await expect(disk.read()).rejects.toThrow('当前平台或文件系统不支持安全的只读参考图片打开方式，已拒绝读取。 尚未上传任何参考图片。')
    expect(disk.files.realpath).not.toHaveBeenCalled()
    expect(disk.files.lstat).not.toHaveBeenCalled()
    expect(disk.files.open).not.toHaveBeenCalled()
    expect(disk.handles).toHaveLength(0)
  } finally {
    vi.doUnmock('node:fs')
    vi.resetModules()
  }
})

it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])('fails closed on strict open-flag incompatibility %s, without unsafe retry', async (code) => {
  const disk = fakeDisk()
  disk.files.open.mockRejectedValue(fileError(code))
  await expect(disk.read()).rejects.toThrow(/不支持安全的只读.*尚未上传/)
  expect(disk.files.open).toHaveBeenCalledTimes(1)
  expect(disk.handles).toHaveLength(0)
})

it.each(['stat', 'open', 'fd-stat', 'read', 'close'])('never exposes raw private filesystem diagnostics on %s failure', async (stage) => {
  const disk = fakeDisk(stage === 'close' ? await isolatedReader() : readImageReferences)
  if (stage === 'stat') disk.files.lstat.mockRejectedValue(fileError('EACCES'))
  else if (stage === 'open') disk.files.open.mockRejectedValue(fileError('EACCES'))
  else disk.state.onOpen = (handle) => {
    if (stage === 'fd-stat') handle.stat.mockRejectedValue(fileError('EIO'))
    else if (stage === 'read') handle.read.mockRejectedValue(fileError('EIO'))
    else handle.close.mockRejectedValue(fileError('EIO'))
  }
  const error: unknown = await disk.read().catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('尚未上传任何参考图片')
  expect((error as Error).message).not.toContain(privateDiagnostic)
  expect((error as Error).message).not.toContain('/private')
  if (stage === 'fd-stat' || stage === 'read' || stage === 'close') expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
  if (stage === 'close') expect((error as Error).message).toBe(quarantineMessage)
})

it('rejects pre-aborted inputs without FS access or echoing the abort reason', async () => {
  const disk = fakeDisk()
  const controller = new AbortController()
  controller.abort(new Error(privateDiagnostic))
  await expect(disk.read(['reference.png'], controller.signal)).rejects.toThrow(/等待已中止.*尚未上传/)
  expect(disk.files.realpath).not.toHaveBeenCalled()
  expect(disk.files.open).not.toHaveBeenCalled()
})

it('retains the process slot across a late open, closes its late FD, and only then permits new readers', async () => {
  const disk = fakeDisk()
  const replacement = fakeDisk()
  const entered = deferred<void>()
  const release = deferred<void>()
  const open = disk.files.open.getMockImplementation()!
  disk.files.open.mockImplementationOnce(async (path, flags) => {
    const handle = await open(path, flags)
    entered.resolve()
    await release.promise
    return handle
  })
  const controller = new AbortController()
  const pending = disk.read(['reference.png'], controller.signal)
  const rejected = expect(pending).rejects.toThrow(/等待已中止.*尚未上传/)
  try {
    await entered.promise
    controller.abort(new Error(privateDiagnostic))
    await rejected
    expect(disk.handles[0].close).not.toHaveBeenCalled()
    await expect(replacement.read()).rejects.toThrow('未结束的参考图片读取或关闭')
    await expect(disk.read()).rejects.toThrow('未结束的参考图片读取或关闭')
    expect(replacement.files.realpath).not.toHaveBeenCalled()
    expect(await replacement.read([])).toEqual([])
    expect(disk.files.open).toHaveBeenCalledTimes(1)
    release.resolve()
    await drain()
    expect(disk.handles[0].read).not.toHaveBeenCalled()
    expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    expect(await replacement.read()).toHaveLength(1)
  } finally {
    controller.abort()
    release.resolve()
    await drain()
    await rejected
  }
})

it('does not release the slot while a cancelled late stat is still pending or rejecting', async () => {
  const disk = fakeDisk()
  const blocked = deferred<ImageInputFileStat>()
  const entered = deferred<void>()
  disk.files.lstat.mockImplementationOnce(() => { entered.resolve(); return blocked.promise })
  const controller = new AbortController()
  const pending = disk.read(['reference.png'], controller.signal)
  const rejected = expect(pending).rejects.toThrow('等待已中止')
  try {
    await entered.promise
    controller.abort()
    await rejected
    await expect(fakeDisk().read()).rejects.toThrow('未结束')
    blocked.reject(fileError('EIO'))
    await drain()
    expect(disk.files.open).not.toHaveBeenCalled()
    expect(await fakeDisk().read()).toHaveLength(1)
  } finally {
    controller.abort()
    blocked.reject(fileError('EIO'))
    await drain()
    await rejected
  }
})

it.each(['fd-stat', 'read', 'close'])('keeps a hung %s operation backpressured after timeout, including replacement reader instances', async (stage) => {
  const disk = fakeDisk()
  const release = deferred<void>()
  const entered = deferred<void>()
  disk.state.onOpen = (handle) => {
    if (stage === 'fd-stat') {
      const stat = handle.stat.getMockImplementation()!
      handle.stat.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return stat() })
    } else if (stage === 'read') {
      const read = handle.read.getMockImplementation()!
      handle.read.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args) })
    } else handle.close.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  }
  const controller = new AbortController()
  const pending = disk.read(['reference.png'], controller.signal)
  const rejected = expect(pending).rejects.toThrow(/等待超时.*尚未上传/)
  try {
    await entered.promise
    controller.abort(new transport.CodexImageError('timeout', privateDiagnostic))
    await rejected
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = fakeDisk()
      await expect(next.read()).rejects.toThrow('未结束')
      expect(next.files.realpath).not.toHaveBeenCalled()
      expect(next.files.open).not.toHaveBeenCalled()
    }
    if (stage !== 'close') expect(disk.handles[0].close).not.toHaveBeenCalled()
    else expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    release.resolve()
    await drain()
    expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    expect(await fakeDisk().read()).toHaveLength(1)
  } finally {
    controller.abort()
    release.resolve()
    await drain()
    await rejected
  }
})

it('quarantines a settled close failure, stops before the second image, and blocks new readers without FS access', async () => {
  const reader = await isolatedReader()
  const disk = fakeDisk(reader)
  disk.put('second.png', 'file', png)
  const release = deferred<void>()
  const entered = deferred<void>()
  disk.state.onOpen = (handle) => handle.close.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    throw fileError('EIO')
  })
  const pending = disk.read(['reference.png', 'second.png'])
  const rejected = expect(pending).rejects.toThrow(quarantineMessage)
  try {
    await entered.promise
    const waiting = fakeDisk(reader)
    await expect(waiting.read()).rejects.toThrow('未结束')
    expect(waiting.files.realpath).not.toHaveBeenCalled()
    expect(waiting.files.lstat).not.toHaveBeenCalled()
    expect(waiting.files.open).not.toHaveBeenCalled()
    expect(await waiting.read([])).toEqual([])
    release.resolve()
    await rejected
    expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    expect(disk.files.open.mock.calls.map(([path]) => path)).toEqual([resolve(cwd, 'reference.png')])
    const fsCalls = [disk.files.realpath.mock.calls.length, disk.files.lstat.mock.calls.length]
    const reads = disk.handles[0].read.mock.calls.length
    await expect(disk.read()).rejects.toThrow(quarantineMessage)
    expect([disk.files.realpath.mock.calls.length, disk.files.lstat.mock.calls.length]).toEqual(fsCalls)
    expect(disk.files.open).toHaveBeenCalledTimes(1)
    expect(disk.handles[0].read).toHaveBeenCalledTimes(reads)
    expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    for (let attempt = 0; attempt < 3; attempt++) {
      const replacement = fakeDisk(reader)
      const error = await replacement.read().catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(quarantineMessage)
      expect((error as Error).message).not.toContain(privateDiagnostic)
      expect((error as Error).message).not.toContain('未结束')
      expect(replacement.files.realpath).not.toHaveBeenCalled()
      expect(replacement.files.lstat).not.toHaveBeenCalled()
      expect(replacement.files.open).not.toHaveBeenCalled()
    }
    // Restoring fake FS mocks must not revive the same reader's latch.
    vi.restoreAllMocks()
    const replacement = fakeDisk(reader)
    const controller = new AbortController()
    controller.abort(new Error(privateDiagnostic))
    await expect(replacement.read(['reference.png'], controller.signal)).rejects.toThrow(quarantineMessage)
    expect(await reader({} as ImageReferenceRoot, [], controller.signal, { files: replacement.files })).toEqual([])
    expect(replacement.files.realpath).not.toHaveBeenCalled()
    expect(replacement.files.lstat).not.toHaveBeenCalled()
    expect(replacement.files.open).not.toHaveBeenCalled()
    expect(await fakeDisk().read()).toHaveLength(1) // Static suite reader was not quarantined.
  } finally {
    release.resolve()
    await rejected
  }
})

it('latches a late close rejection even after the aborted consumer has returned, without retrying or starting more reads', async () => {
  const reader = await isolatedReader()
  const disk = fakeDisk(reader)
  disk.put('second.png', 'file', png)
  const release = deferred<void>()
  const entered = deferred<void>()
  disk.state.onOpen = (handle) => handle.close.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
  })
  const controller = new AbortController()
  const pending = disk.read(['reference.png', 'second.png'], controller.signal)
  const rejected = expect(pending).rejects.toThrow(/等待已中止.*尚未上传/)
  try {
    await entered.promise
    controller.abort(new Error(privateDiagnostic))
    await rejected
    const abortError = await pending.catch((failure: unknown) => failure)
    expect((abortError as Error).message).not.toContain(privateDiagnostic)
    expect((abortError as Error).message).not.toContain('/private')
    const waiting = fakeDisk(reader)
    await expect(waiting.read()).rejects.toThrow('未结束')
    expect(await waiting.read([])).toEqual([])
    expect(waiting.files.realpath).not.toHaveBeenCalled()
    expect(waiting.files.lstat).not.toHaveBeenCalled()
    expect(waiting.files.open).not.toHaveBeenCalled()
    const reads = disk.handles[0].read.mock.calls.length
    release.reject(fileError('EIO'))
    await drain()
    for (let attempt = 0; attempt < 3; attempt++) {
      const replacement = fakeDisk(reader)
      const error = await replacement.read().catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(quarantineMessage)
      expect((error as Error).message).not.toContain(privateDiagnostic)
      expect((error as Error).message).not.toContain('未结束')
      expect(await replacement.read([])).toEqual([])
      expect(replacement.files.realpath).not.toHaveBeenCalled()
      expect(replacement.files.lstat).not.toHaveBeenCalled()
      expect(replacement.files.open).not.toHaveBeenCalled()
    }
    await expect(disk.read()).rejects.toThrow(quarantineMessage)
    expect(disk.files.open).toHaveBeenCalledTimes(1)
    expect(disk.handles[0].read).toHaveBeenCalledTimes(reads)
    expect(disk.handles[0].close).toHaveBeenCalledTimes(1)
    expect(await fakeDisk().read()).toHaveLength(1)
  } finally {
    controller.abort()
    release.reject(fileError('EIO'))
    await drain()
    await rejected
  }
})
