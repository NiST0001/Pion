// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { inflate } from 'node:zlib'

// Private, inherited stdio only. IDs correlate this spawn; they do not authenticate peers.
export const HELPER_PREVIEW_MAX = 96 * 1024
export const HELPER_JSON_MAX = 4096 + 128 * 1024
export const HELPER_BINARY_MAX = 8 * 1024 * 1024
export interface HelperReply { id: number; generation: number; kind: 'hello' | 'unavailable' | 'opened' | 'frame' | 'closed' | 'error' | 'revoked'; deliverable?: boolean; width?: number; height?: number; sourceType?: number; streamId?: string; previewPng?: string }
interface HelperResult { reply: HelperReply; bytes: Buffer; previewPng?: Uint8Array }
export type HelperSpawn = (path: string) => ChildProcessWithoutNullStreams
export function encodeHelperPacket(value: unknown, bytes: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(value))
  if (!json.length || json.length > HELPER_JSON_MAX || bytes.length > HELPER_BINARY_MAX) throw new Error('helper-protocol')
  const header = Buffer.alloc(12)
  header.write('PCU1'); header.writeUInt32BE(json.length, 4); header.writeUInt32BE(bytes.length, 8)
  return Buffer.concat([header, json, bytes])
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Only helper-produced static RGB8 PNG, no metadata. Never inflate model PNG here. */
function previewData(value: unknown): { png: Buffer; compressed: Buffer; width: number; height: number } {
  if (typeof value !== 'string' || !value.length || value.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('helper-preview')
  const png = Buffer.from(value, 'base64')
  if (png.toString('base64') !== value || png.length > HELPER_PREVIEW_MAX || png.length < 57 || !png.subarray(0, 8).equals(pngSignature)) throw new Error('helper-preview')
  let width = 0; let height = 0; let ended = false
  const data: Buffer[] = []
  let chunks = 0
  for (let pos = 8; pos < png.length;) {
    if (++chunks > 64) throw new Error('helper-preview')
    if (pos + 12 > png.length) throw new Error('helper-preview')
    const length = png.readUInt32BE(pos); const end = pos + 12 + length
    if (end > png.length) throw new Error('helper-preview')
    const kind = png.toString('ascii', pos + 4, pos + 8)
    let crc = 0xffffffff
    for (const byte of png.subarray(pos + 4, end - 4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    if (((crc ^ 0xffffffff) >>> 0) !== png.readUInt32BE(end - 4)) throw new Error('helper-preview')
    if (pos === 8 && kind === 'IHDR' && length === 13) {
      width = png.readUInt32BE(pos + 8); height = png.readUInt32BE(pos + 12)
      if (!width || !height || width > 512 || height > 512 || !png.subarray(pos + 16, pos + 21).equals(Buffer.from([8, 2, 0, 0, 0]))) throw new Error('helper-preview')
    } else if (kind === 'IDAT' && width && !ended) data.push(png.subarray(pos + 8, end - 4))
    else if (kind === 'IEND' && !length && data.length && end === png.length) ended = true
    else throw new Error('helper-preview')
    pos = end
  }
  if (!ended) throw new Error('helper-preview')
  return { png, compressed: Buffer.concat(data), width, height }
}
export function decodeHelperPreview(value: unknown): Promise<Uint8Array> {
  const { png, compressed, width, height } = previewData(value)
  const row = width * 3 + 1; const expected = row * height
  return new Promise((resolve, reject) => {
    // libuv worker, bounded to at most 786944 bytes; no main-thread full-image decode.
    inflate(compressed, { maxOutputLength: expected, info: true }, (error, result) => {
      if (error || !result) { reject(new Error('helper-preview')); return }
      const decoded = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== compressed.length) { reject(new Error('helper-preview')); return }
      for (let y = 0; y < height; y++) if (decoded.buffer[y * row] > 4) { reject(new Error('helper-preview')); return }
      resolve(Uint8Array.from(png))
    })
  })
}
export class HelperPacketReader {
  private header = Buffer.alloc(12)
  private headerUsed = 0
  private body?: Buffer
  private bodyUsed = 0
  private jsonLength = 0
  get incomplete(): boolean { return this.headerUsed !== 0 || this.body !== undefined }
  push(chunk: Buffer, receive: (reply: HelperReply, bytes: Buffer) => void): void {
    let pos = 0
    while (pos < chunk.length) {
      if (!this.body) {
        const count = Math.min(12 - this.headerUsed, chunk.length - pos)
        chunk.copy(this.header, this.headerUsed, pos, pos + count); pos += count; this.headerUsed += count
        if (this.headerUsed !== 12) continue
        this.jsonLength = this.header.readUInt32BE(4)
        const binaryLength = this.header.readUInt32BE(8)
        if (this.header.toString('ascii', 0, 4) !== 'PCU1' || !this.jsonLength || this.jsonLength > HELPER_JSON_MAX || binaryLength > HELPER_BINARY_MAX) throw new Error('helper-protocol')
        this.body = Buffer.alloc(this.jsonLength + binaryLength)
      }
      const count = Math.min(this.body.length - this.bodyUsed, chunk.length - pos)
      chunk.copy(this.body, this.bodyUsed, pos, pos + count); pos += count; this.bodyUsed += count
      if (this.bodyUsed !== this.body.length) continue
      const text = this.body.subarray(0, this.jsonLength).toString('utf8')
      if (!Buffer.from(text).equals(this.body.subarray(0, this.jsonLength))) throw new Error('helper-protocol')
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('helper-protocol')
      const v = value as Record<string, unknown>
      if (Object.keys(v).some(k => !['id', 'generation', 'kind', 'width', 'height', 'sourceType', 'streamId', 'previewPng', 'deliverable'].includes(k)) || !Number.isSafeInteger(v.id) || (v.id as number) < 0 || !Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || !['hello', 'unavailable', 'opened', 'frame', 'closed', 'error', 'revoked'].includes(v.kind as string) || (v.id === 0) !== (v.kind === 'revoked')) throw new Error('helper-protocol')
      if (this.jsonLength > 4096 && v.previewPng === undefined) throw new Error('helper-protocol')
      const bytes = this.body.subarray(this.jsonLength)
      if (v.kind === 'frame') {
        if (typeof v.deliverable !== 'boolean' || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || (v.width as number) < 1 || (v.height as number) < 1 || (v.width as number) > 4096 || (v.height as number) > 4096 || (v.width as number) * (v.height as number) > 8_000_000 || v.sourceType !== undefined || v.streamId !== undefined || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== v.width || bytes.readUInt32BE(20) !== v.height) throw new Error('helper-protocol')
        if (v.previewPng !== undefined) {
          // Only bounded transport syntax here. Full PNG validation belongs to the
          // owned decode task, so a corrupt preview cannot discard complete raw bytes.
          if (typeof v.previewPng !== 'string' || !v.previewPng.length || v.previewPng.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.previewPng)) throw new Error('helper-preview')
          const preview = Buffer.from(v.previewPng, 'base64')
          if (preview.length > HELPER_PREVIEW_MAX || preview.toString('base64') !== v.previewPng) throw new Error('helper-preview')
        }
      } else if (bytes.length || v.width !== undefined || v.height !== undefined || v.previewPng !== undefined || v.deliverable !== undefined) throw new Error('helper-protocol')
      if (v.kind === 'opened') {
        if (v.sourceType !== 2 || typeof v.streamId !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(v.streamId) || Number(v.streamId) > 0xffffffff) throw new Error('helper-scope')
      } else if (v.sourceType !== undefined || v.streamId !== undefined) throw new Error('helper-protocol')
      this.body = undefined; this.bodyUsed = 0; this.headerUsed = 0
      receive(v as unknown as HelperReply, bytes)
    }
  }
}
interface Pending { kind: string; received?: boolean; receivedFrame?: boolean; resolve: (value: HelperResult) => void; reject: (error: Error) => void }
export class ComputerUseHelperClient {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 0
  private poisoned = false
  private closing?: Promise<void>
  private exit?: Promise<void>
  private closedProtocolAck = false
  private exitProof = false
  private exited = false
  private closingGate = false
  private revoked = false
  private readonly revokedListeners = new Set<() => void>()
  private readonly decodes = new Set<Promise<unknown>>()
  private readonly requests = new Set<Promise<HelperResult>>()
  constructor(private readonly binary: string, private readonly generation: number, private readonly start: HelperSpawn = path => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })) {
    if (!isAbsolute(binary)) throw new Error('helper-path')
  }
  get actualPending(): boolean { return Boolean(this.child) }
  get transportUnknown(): boolean { return this.poisoned }
  onRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener)
    return () => { this.revokedListeners.delete(listener) }
  }
  request(kind: 'hello' | 'open' | 'capture', limits?: { maxFrameBytes: number; maxFramePixels: number; maxFrameEdge: number }): Promise<HelperResult> {
    if (this.poisoned || this.closingGate || this.revoked || this.pending.size) return Promise.reject(new Error('helper-busy'))
    if (!this.child) this.launch()
    return this.send(kind, limits)
  }
  private launch(): void {
    const child = this.start(this.binary); this.child = child
    const reader = new HelperPacketReader()
    this.exit = new Promise(resolve => child.once('close', (code: number | null, signal: string | null) => {
      // Exit without portal close ACK is unknown, never a clean restart permit.
      this.exited = true
      this.exitProof = code === 0 && signal === null
      if (!this.closedProtocolAck || !this.exitProof || reader.incomplete || [...this.pending.values()].some(p => !p.received)) this.fail('helper-exited')
      resolve()
    }))
    child.stdout.on('data', (chunk: Buffer) => {
      try { reader.push(chunk, (reply, bytes) => {
        if (reply.generation !== this.generation) throw new Error('helper-stale')
        if (reply.kind === 'revoked') {
          if (this.revoked || this.closedProtocolAck || this.poisoned) throw new Error('helper-stale')
          this.notifyRevoked()
          return
        }
        if (!this.pending.has(reply.id)) throw new Error('helper-stale')
        if (reply.kind !== 'frame' && bytes.length) throw new Error('helper-protocol')
        const p = this.pending.get(reply.id)!
        if (p.received) throw new Error('helper-protocol')
        const allowed: Record<string, readonly string[]> = { hello: ['hello', 'error'], open: ['opened', 'unavailable', 'error'], capture: ['frame', 'error'], close: ['closed', 'error'] }
        if (!allowed[p.kind]?.includes(reply.kind)) throw new Error('helper-protocol')
        p.received = true
        p.receivedFrame = p.kind === 'capture' && reply.kind === 'frame'
        if (p.kind === 'close' && reply.kind === 'error') { this.fail(); return }
        if (reply.kind === 'closed') {
          this.closedProtocolAck = true
          // ACK cannot stand in for a missing normal response.
          if ([...this.pending.values()].some(other => !other.received)) { this.fail(); return }
        }
        const finish = (previewPng?: Uint8Array): void => {
          if (this.pending.get(reply.id) !== p) return
          this.pending.delete(reply.id)
          const deliverable = reply.kind === 'frame' && (this.poisoned || this.closingGate || this.revoked) ? false : reply.deliverable
          p.resolve({ reply: { ...reply, ...(reply.kind === 'frame' ? { deliverable } : {}) }, bytes, ...(previewPng && !this.poisoned ? { previewPng } : {}) })
        }
        if (reply.previewPng !== undefined) {
          // Include synchronous PNG validation throws in the same actual task.
          const decode = Promise.resolve().then(() => decodeHelperPreview(reply.previewPng)).then(previewPng => {
            const png = Buffer.from(previewPng)
            if (png.readUInt32BE(16) > reply.width! || png.readUInt32BE(20) > reply.height!) throw new Error('helper-preview')
            return previewPng
          }).then(finish, () => { this.fail(); finish() })
          this.decodes.add(decode)
          void decode.then(() => { this.decodes.delete(decode) })
        } else finish()
      }) } catch { this.fail() }
    })
    child.stdout.on('end', () => { if (reader.incomplete || !this.closedProtocolAck) this.fail() })
    child.stderr.on('data', () => { /* Deliberately discard diagnostics, titles and URIs. */ })
    child.on('error', () => this.fail())
    child.stdin.on('error', () => this.fail())
  }
  private notifyRevoked(): void {
    if (this.revoked) return
    this.revoked = true
    // Listener errors cannot recursively poison/notify the transport.
    for (const listener of this.revokedListeners) { try { listener() } catch { /* Metadata notification only. */ } }
  }
  private fail(reason = 'helper-unknown'): void {
    this.poisoned = true
    // A complete admitted capture retains its physical bytes and actual decode.
    // Missing or non-frame responses are not evidence of any generated image.
    for (const [id, p] of this.pending) if (!p.receivedFrame) {
      p.reject(new Error(reason)); this.pending.delete(id)
    }
    this.notifyRevoked()
  }
  private send(kind: string, limits?: unknown): Promise<HelperResult> {
    const id = ++this.nextId
    const actual = new Promise<HelperResult>((resolve, reject) => {
      this.pending.set(id, { kind, resolve, reject })
      const packet = encodeHelperPacket({ id, generation: this.generation, kind, ...(limits ? { limits } : {}) })
      // Preview headroom belongs only to replies; native request headers stay 4 KiB.
      if (packet.readUInt32BE(4) > 4096) { this.fail(); return }
      this.child!.stdin.write(packet, error => { if (error) this.fail() })
    })
    this.requests.add(actual)
    void actual.then(() => { this.requests.delete(actual) }, () => { this.requests.delete(actual) })
    return actual
  }
  close(): Promise<void> {
    this.closingGate = true
    if (this.closing) return this.closing
    if (!this.child) return (this.closing = Promise.resolve())
    this.closing = (async () => {
      let acknowledged = false
      try {
        if (!this.exited) {
          const { reply } = await this.send('close')
          acknowledged = reply.kind === 'closed'
        }
      } catch { /* Still await physical exit and actual decode callbacks. */ }
      this.child!.stdin.end()
      await this.exit
      await Promise.allSettled([...this.decodes, ...this.requests])
      if (!acknowledged || !this.closedProtocolAck || !this.exitProof || this.poisoned || this.pending.size) throw new Error('helper-stop-unverified')
      this.child = undefined
    })()
    return this.closing
  }
}
/** Cancel waiting only; underlying request remains held by its client until reply/closure. */
export function waitForHelper<T>(actual: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('helper-interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    actual.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value) }, () => { signal.removeEventListener('abort', abort); reject(new Error('helper-failed')) })
    if (signal.aborted) abort()
  })
}
