// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { inflate } from 'node:zlib'
import { validateComputerUseAction, type ComputerUseAction } from '../../shared/computer-use'
import type { ComputerUseNativeInputFence } from './input-policy'
import { NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES, NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST, type NativeComputerUseDiagnosticCode, type ComputerUseDiagnosticCode, type ComputerUseDiagnosticOperation, type ComputerUseDiagnostics } from '../../shared/computer-use-diagnostics'

// Private, inherited stdio only. IDs correlate this spawn; they do not authenticate peers.
/** Native attestation of explicit owned DBus-client disconnection, watcher/PW join.
 * Not a poison reset, historical-marker receipt or proof of all OS-internal cleanup. */
export interface HelperCloseReceipt { version: 1; boundary: 'client-disconnected' }
export const HELPER_PREVIEW_MAX = 96 * 1024
export const HELPER_JSON_MAX = 4096 + 128 * 1024
export const HELPER_BINARY_MAX = 8 * 1024 * 1024
export interface HelperNoFrameReceipt { version: 1; outcome: 'no-complete-png' }
export interface HelperReply { id: number; generation: number; dmaBufReadbackVersion?: 1; captureAccountingVersion?: 1; noFrameReceipt?: HelperNoFrameReceipt; inputProtocolVersion?: 1; inputFrame?: ComputerUseNativeInputFence; kind: 'hello' | 'unavailable' | 'opened' | 'frame' | 'acted' | 'closed' | 'error' | 'revoked'; deliverable?: boolean; width?: number; height?: number; sourceType?: number; streamId?: string; previewPng?: string; diagnosticCode?: NativeComputerUseDiagnosticCode; closeReceipt?: HelperCloseReceipt }
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
    const kind = png.subarray(pos + 4, pos + 8)
    let crc = 0xffffffff
    for (const byte of png.subarray(pos + 4, end - 4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    if (((crc ^ 0xffffffff) >>> 0) !== png.readUInt32BE(end - 4)) throw new Error('helper-preview')
    if (pos === 8 && kind.equals(Buffer.from('IHDR')) && length === 13) {
      width = png.readUInt32BE(pos + 8); height = png.readUInt32BE(pos + 12)
      if (!width || !height || width > 512 || height > 512 || !png.subarray(pos + 16, pos + 21).equals(Buffer.from([8, 2, 0, 0, 0]))) throw new Error('helper-preview')
    } else if (kind.equals(Buffer.from('IDAT')) && width && !ended) data.push(png.subarray(pos + 8, end - 4))
    else if (kind.equals(Buffer.from('IEND')) && !length && data.length && end === png.length) ended = true
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
  constructor(private readonly control = false, private readonly accounting = false, private readonly dmaBufReadback = false) {}
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
        if (!this.header.subarray(0, 4).equals(Buffer.from('PCU1')) || !this.jsonLength || this.jsonLength > HELPER_JSON_MAX || binaryLength > HELPER_BINARY_MAX) throw new Error('helper-protocol')
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
      if (Object.keys(v).some(k => !['id', 'generation', 'kind', 'width', 'height', 'sourceType', 'streamId', 'previewPng', 'deliverable', 'diagnosticCode', 'closeReceipt', 'inputProtocolVersion', 'inputFrame', 'captureAccountingVersion', 'noFrameReceipt', 'dmaBufReadbackVersion'].includes(k)) || !Number.isSafeInteger(v.id) || (v.id as number) < 0 || !Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || !['hello', 'unavailable', 'opened', 'frame', 'acted', 'closed', 'error', 'revoked'].includes(v.kind as string) || (v.id === 0) !== (v.kind === 'revoked')) throw new Error('helper-protocol')
      if (Object.hasOwn(v, 'inputProtocolVersion') && (!this.control || v.kind !== 'hello' || v.inputProtocolVersion !== 1)) throw new Error('helper-protocol')
      if (Object.hasOwn(v, 'captureAccountingVersion') && (!this.accounting || v.kind !== 'hello' || v.captureAccountingVersion !== 1)) throw new Error('helper-protocol')
      if (Object.hasOwn(v, 'dmaBufReadbackVersion') && (!this.dmaBufReadback || v.kind !== 'hello' || v.dmaBufReadbackVersion !== 1)) throw new Error('helper-protocol')
      if (Object.hasOwn(v, 'noFrameReceipt')) {
        const receipt = v.noFrameReceipt
        if (!this.accounting || v.kind !== 'error' || v.diagnosticCode !== 'capture-frame-failed' || !receipt || typeof receipt !== 'object' || Object.getPrototypeOf(receipt) !== Object.prototype) throw new Error('helper-protocol')
        const r = receipt as Record<string, unknown>
        if (Object.keys(r).length !== 2 || !Object.hasOwn(r, 'version') || !Object.hasOwn(r, 'outcome') || r.version !== 1 || r.outcome !== 'no-complete-png') throw new Error('helper-protocol')
      }
      if (Object.hasOwn(v, 'inputFrame')) {
        if (!this.control || v.kind !== 'frame') throw new Error('helper-protocol')
        validateNativeInputFence(v.inputFrame)
      }
      if (v.kind === 'acted' && !this.control) throw new Error('helper-protocol')
      if (Object.prototype.hasOwnProperty.call(v, 'diagnosticCode') && (v.kind !== 'error' || typeof v.diagnosticCode !== 'string' || !(NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES as readonly string[]).includes(v.diagnosticCode))) throw new Error('helper-protocol')
      if (Object.prototype.hasOwnProperty.call(v, 'closeReceipt')) {
        const receipt = v.closeReceipt
        if (v.kind !== 'closed' || !receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.getPrototypeOf(receipt) !== Object.prototype) throw new Error('helper-protocol')
        const r = receipt as Record<string, unknown>
        if (Object.keys(r).length !== 2 || !Object.prototype.hasOwnProperty.call(r, 'version') || !Object.prototype.hasOwnProperty.call(r, 'boundary') || r.version !== 1 || r.boundary !== 'client-disconnected') throw new Error('helper-protocol')
      }
      if (this.jsonLength > 4096 && v.previewPng === undefined) throw new Error('helper-protocol')
      const bytes = this.body.subarray(this.jsonLength)
      if (v.kind === 'frame') {
        if (typeof v.deliverable !== 'boolean' || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || (v.width as number) < 1 || (v.height as number) < 1 || (v.width as number) > 4096 || (v.height as number) > 4096 || (v.width as number) * (v.height as number) > 8_000_000 || v.sourceType !== undefined || v.streamId !== undefined || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(Buffer.from('IHDR')) || bytes.readUInt32BE(16) !== v.width || bytes.readUInt32BE(20) !== v.height) throw new Error('helper-protocol')
        if (v.previewPng !== undefined) {
          // Only bounded transport syntax here. Full PNG validation belongs to the
          // owned decode task, so a corrupt preview cannot discard complete raw bytes.
          if (typeof v.previewPng !== 'string' || !v.previewPng.length || v.previewPng.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.previewPng)) throw new Error('helper-preview')
          const preview = Buffer.from(v.previewPng, 'base64')
          if (preview.length > HELPER_PREVIEW_MAX || preview.toString('base64') !== v.previewPng) throw new Error('helper-preview')
        }
      } else if (bytes.length || v.width !== undefined || v.height !== undefined || v.previewPng !== undefined || v.deliverable !== undefined) throw new Error('helper-protocol')
      if (v.kind === 'opened') {
        if (v.sourceType !== (this.control ? 1 : 2) || typeof v.streamId !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(v.streamId) || Number(v.streamId) > 0xffffffff) throw new Error('helper-scope')
      } else if (v.sourceType !== undefined || v.streamId !== undefined) throw new Error('helper-protocol')
      this.body = undefined; this.bodyUsed = 0; this.headerUsed = 0
      receive(v as unknown as HelperReply, bytes)
    }
  }
}
/** Native-issued identity only. Shape validation is not provenance or input authority. */
function validateNativeInputFence(value: unknown): ComputerUseNativeInputFence {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) throw new Error('helper-protocol')
  const v = value as Record<string, unknown>
  if (!Object.hasOwn(v, 'sequence') || !Object.hasOwn(v, 'topology') || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 || !Number.isSafeInteger(v.topology) || (v.topology as number) < 1) throw new Error('helper-protocol')
  return { sequence: v.sequence as number, topology: v.topology as number }
}
type HelperRequestKind = keyof typeof NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST
interface Pending { kind: HelperRequestKind; received?: boolean; receivedFrame?: boolean; resolve: (value: HelperResult) => void; reject: (error: Error) => void }
export class ComputerUseHelperClient {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private readonly diagnostics: ComputerUseDiagnostics = {}
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
  private inputNegotiated = false
  private accountingNegotiated = false
  private dmaBufNegotiated = false
  private executionObserved = false
  private startupIoEnded = false
  private preexecErrno?: number
  private stdioClosed?: Promise<void>
  constructor(private readonly binary: string, private readonly generation: number, private readonly start?: HelperSpawn, private readonly control = false, private readonly accounting = false, private readonly dmaBufReadback = false) {
    if (!isAbsolute(binary)) throw new Error('helper-path')
  }
  /** Pure bounded cache; never connects or probes the helper/OS. */
  getDiagnostics(): ComputerUseDiagnostics { return { ...this.diagnostics } }
  private recordDiagnostic(code: ComputerUseDiagnosticCode, operation: ComputerUseDiagnosticOperation): void {
    this.diagnostics[operation] ??= code
  }
  private currentOperation(): ComputerUseDiagnosticOperation {
    const kind = this.pending.values().next().value?.kind
    return kind === 'hello' ? 'open' : kind ?? (this.closingGate ? 'close' : 'open')
  }
  get actualPending(): boolean { return Boolean(this.child) }
  get transportUnknown(): boolean { return this.poisoned }
  onRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener)
    return () => { this.revokedListeners.delete(listener) }
  }
  request(kind: 'hello' | 'open' | 'capture', limits?: { maxFrameBytes: number; maxFramePixels: number; maxFrameEdge: number }): Promise<HelperResult> {
    if (this.poisoned || this.preexecErrno !== undefined || this.closingGate || this.revoked || this.pending.size) return Promise.reject(new Error('helper-busy'))
    if (this.accounting && kind !== 'hello' && !this.accountingNegotiated) return Promise.reject(new Error('helper-accounting-unavailable'))
    if (this.control && kind !== 'hello' && !this.inputNegotiated) return Promise.reject(new Error('helper-input-unavailable'))
    if (this.dmaBufReadback && kind !== 'hello' && !this.dmaBufNegotiated) return Promise.reject(new Error('helper-dmabuf-unavailable'))
    if (!this.child) {
      try { this.launch() } catch {
        this.fail('helper-transport-error', kind === 'hello' ? 'open' : kind)
        return Promise.reject(new Error('helper-unknown'))
      }
    }
    return this.send(kind, { ...(limits ? { limits } : {}), ...(kind === 'open' && this.control ? { control: true, captureScope: 'display' } : {}) })
  }
  act(action: ComputerUseAction, frame: ComputerUseNativeInputFence): Promise<HelperResult> {
    if (!this.control || !this.inputNegotiated || (this.accounting && !this.accountingNegotiated) || (this.dmaBufReadback && !this.dmaBufNegotiated) || !this.child || this.poisoned || this.closingGate || this.revoked || this.pending.size) return Promise.reject(new Error('helper-input-unavailable'))
    try {
      const nativeFrame = validateNativeInputFence(frame)
      // Service checks actual image bounds/provenance; native repeats these checks.
      const width = action && 'x' in action && Number.isSafeInteger(action.x) ? action.x + 1 : 1
      const height = action && 'y' in action && Number.isSafeInteger(action.y) ? action.y + 1 : 1
      const validated = validateComputerUseAction(action, { id: 'native-validation', width, height, createdAt: 0, scopeRevision: 0, captureScope: 'display', actualScope: 'display' })
      return this.send('act', { frame: nativeFrame, action: validated })
    } catch { return Promise.reject(new Error('helper-input-invalid')) }
  }
  private launch(): void {
    const args = ['--client-close-receipt-v1', ...(this.control ? ['--wayland-virtual-input-v1'] : []), ...(this.accounting ? ['--capture-accounting-v1'] : []), ...(this.dmaBufReadback ? ['--dmabuf-readback-v1'] : [])]
    const child = this.start ? this.start(this.binary) : spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); this.child = child
    const reader = new HelperPacketReader(this.control, this.accounting, this.dmaBufReadback)
    this.stdioClosed = Promise.all([child.stdin, child.stdout, child.stderr].map(stream => new Promise<void>(resolve => stream.once('close', resolve)))).then(() => {})
    child.once('spawn', () => {
      if (this.child !== child) return
      this.executionObserved = true
      if (this.preexecErrno !== undefined || this.startupIoEnded) this.fail('helper-transport-error')
    })
    child.once('exit', () => {
      if (this.child !== child) return
      if (this.preexecErrno !== undefined || !this.executionObserved) this.fail('helper-exit-unverified')
      this.executionObserved = true
    })
    this.exit = new Promise(resolve => child.once('close', (code: number | null, signal: string | null) => {
      if (this.child !== child) { resolve(); return }
      // Process close includes stdio closure. Either native close boundary still
      // needs normal zero close, all replies and actual decodes; never reset poison.
      this.exited = true
      this.exitProof = code === 0 && signal === null
      if (this.preexecErrno !== undefined) {
        if (code !== this.preexecErrno || signal !== null || this.executionObserved || reader.incomplete) this.fail('helper-exit-unverified')
        resolve(); return
      }
      if (!this.closedProtocolAck || !this.exitProof || reader.incomplete || [...this.pending.values()].some(p => !p.received)) this.fail('helper-exit-unverified')
      resolve()
    }))
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.executionObserved = true
      try {
        if (this.exited || this.preexecErrno !== undefined || this.startupIoEnded) throw new Error('helper-stale')
        reader.push(chunk, (reply, bytes) => {
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
        const allowed: Record<string, readonly string[]> = { hello: ['hello', 'error'], open: ['opened', 'unavailable', 'error'], capture: ['frame', 'error'], act: ['acted', 'error'], close: ['closed', 'error'] }
        if (!allowed[p.kind]?.includes(reply.kind)) throw new Error('helper-protocol')
        if (reply.diagnosticCode !== undefined) {
          if (!(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST[p.kind] as readonly string[]).includes(reply.diagnosticCode)) throw new Error('helper-protocol')
          this.recordDiagnostic(reply.diagnosticCode, p.kind === 'hello' ? 'open' : p.kind)
        }
        if (reply.noFrameReceipt !== undefined && (p.kind !== 'capture' || !this.accountingNegotiated || this.poisoned)) throw new Error('helper-protocol')
        if (p.kind === 'hello') {
          this.inputNegotiated = reply.kind === 'hello' && reply.inputProtocolVersion === 1
          this.accountingNegotiated = this.accounting && reply.kind === 'hello' && reply.captureAccountingVersion === 1
          this.dmaBufNegotiated = this.dmaBufReadback && reply.kind === 'hello' && reply.dmaBufReadbackVersion === 1
        }
        p.received = true
        p.receivedFrame = p.kind === 'capture' && reply.kind === 'frame'
        if (p.kind === 'close' && reply.kind === 'error') { this.fail('helper-protocol-invalid', 'close'); return }
        if (reply.kind === 'closed') {
          // Legacy closed means standard Session close; closeReceipt additionally
          // attests the explicit owned-client-disappearance boundary. Both require
          // this spawn's pending close identity and the same physical settlement.
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
          }).then(finish, () => { this.fail('helper-preview-invalid', 'capture'); finish() })
          this.decodes.add(decode)
          void decode.then(() => { this.decodes.delete(decode) })
        } else finish()
      }) } catch (error) { this.fail(error instanceof Error && error.message === 'helper-preview' ? 'helper-preview-invalid' : 'helper-protocol-invalid') }
    })
    child.stdout.on('end', () => {
      if (this.child !== child) return
      // EOF alone proves nothing. Hold starting until a trusted spawn error or
      // actual spawn/traffic/close determines the outcome; never clear poison.
      if (!this.executionObserved && !this.poisoned) this.startupIoEnded = true
      else if (reader.incomplete || !this.closedProtocolAck) this.fail('helper-protocol-invalid')
    })
    child.stderr.on('data', () => {
      // Discard text. Its existence prevents a later claim that no helper executed.
      if (this.child !== child) return
      this.executionObserved = true
      if (this.preexecErrno !== undefined || this.startupIoEnded) this.fail('helper-transport-error')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      const e = error as NodeJS.ErrnoException & { path?: unknown; spawnargs?: unknown }
      // Node's owned spawn failure, not text, pid absence or an exit-code inference.
      if (!this.poisoned && !this.exited && !this.executionObserved && this.preexecErrno === undefined && child.pid === undefined && child.spawnfile === this.binary && Array.isArray(child.spawnargs) && child.spawnargs.length === args.length + 1 && child.spawnargs[0] === this.binary && child.spawnargs.slice(1).every((arg, i) => arg === args[i]) && e instanceof Error && ((e.code === 'ENOENT' && e.errno === -2) || (e.code === 'EACCES' && e.errno === -13)) && e.syscall === `spawn ${this.binary}` && e.path === this.binary && Array.isArray(e.spawnargs) && e.spawnargs.length === args.length && e.spawnargs.every((arg, i) => arg === args[i])) {
        this.preexecErrno = e.errno
        this.recordDiagnostic('helper-transport-error', this.currentOperation())
        for (const [id, p] of this.pending) { p.reject(new Error('helper-not-executed')); this.pending.delete(id) }
        this.notifyRevoked()
      } else this.fail('helper-transport-error')
    })
    child.stdin.on('error', error => { this.stdinFailure(child, error) })
  }
  private stdinFailure(child: ChildProcessWithoutNullStreams, error: unknown): void {
    if (this.child !== child) return
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    // Node may report failed-start writes before the owned process error. Defer
    // only expected pipe failures; a later successful spawn/traffic poisons them.
    if (!this.executionObserved && !this.poisoned && !this.exited && (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED')) {
      this.startupIoEnded = true
    } else this.fail('helper-transport-error')
  }
  private notifyRevoked(): void {
    if (this.revoked) return
    this.revoked = true
    // Listener errors cannot recursively poison/notify the transport.
    for (const listener of this.revokedListeners) { try { listener() } catch { /* Metadata notification only. */ } }
  }
  private fail(code: 'helper-protocol-invalid' | 'helper-exit-unverified' | 'helper-transport-error' | 'helper-preview-invalid' = 'helper-protocol-invalid', operation = this.currentOperation()): void {
    this.recordDiagnostic(code, operation)
    const reason = code === 'helper-exit-unverified' ? 'helper-exited' : 'helper-unknown'
    this.poisoned = true
    // A complete admitted capture retains its physical bytes and actual decode.
    // Missing or non-frame responses are not evidence of any generated image.
    for (const [id, p] of this.pending) if (!p.receivedFrame) {
      p.reject(new Error(reason)); this.pending.delete(id)
    }
    this.notifyRevoked()
  }
  private send(kind: HelperRequestKind, fields: Record<string, unknown> = {}): Promise<HelperResult> {
    const id = ++this.nextId
    const actual = new Promise<HelperResult>((resolve, reject) => {
      this.pending.set(id, { kind, resolve, reject })
      const packet = encodeHelperPacket({ id, generation: this.generation, kind, ...fields })
      // Act carries bounded text; preview headroom still belongs only to replies.
      if (packet.readUInt32BE(4) > (kind === 'act' ? 16 * 1024 : 4096)) { this.fail(); return }
      const child = this.child!
      try {
        child.stdin.write(packet, error => {
          if (error) this.stdinFailure(child, error)
        })
      } catch (error) { this.stdinFailure(child, error) }
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
        if (!this.exited && this.preexecErrno === undefined) {
          const { reply } = await this.send('close')
          acknowledged = reply.kind === 'closed'
        }
      } catch { /* Still await physical exit and actual decode callbacks. */ }
      try { this.child!.stdin.end() } catch (error) { this.stdinFailure(this.child!, error) }
      await this.exit
      await Promise.allSettled([...this.decodes, ...this.requests])
      if (this.preexecErrno !== undefined && !this.poisoned) {
        await this.stdioClosed
        if (!this.poisoned && this.exited && !this.executionObserved && !this.pending.size) { this.child = undefined; return }
      }
      if (!acknowledged || !this.closedProtocolAck || !this.exitProof || this.poisoned || this.pending.size) {
        this.recordDiagnostic('helper-exit-unverified', 'close')
        throw new Error('helper-stop-unverified')
      }
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
