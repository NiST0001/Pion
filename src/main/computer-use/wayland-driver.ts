// SPDX-License-Identifier: MIT
import type { ComputerUseAction, ComputerUseCapability, ComputerUseOwner } from '../../shared/computer-use'
import type { ComputerUseDiagnostics } from '../../shared/computer-use-diagnostics'
import { validateComputerUseOwner } from '../../shared/computer-use'
import type { ComputerUseDriver, ComputerUseDriverFrame, ComputerUseDriverLimits, ComputerUseDriverOpenOptions } from './driver'
import type { ComputerUseNativeInputFence } from './input-policy'
import { ComputerUseHelperClient, waitForHelper, type HelperSpawn } from './helper-client'

/** Explicit absolute project helper path; no probing, chooser or spawn in constructor. */
export class WaylandComputerUseDriver implements ComputerUseDriver {
  private client?: ComputerUseHelperClient
  private closed = false
  private captureUnknown = false
  private control = false
  private streamId?: string
  private limits?: ComputerUseDriverLimits
  private readonly revokedListeners = new Set<() => void>()
  getDiagnostics(): ComputerUseDiagnostics { return this.client?.getDiagnostics() ?? {} }
  onRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener)
    return () => { this.revokedListeners.delete(listener) }
  }
  constructor(private readonly binary: string, private readonly dmaBufReadback = false, private readonly start?: HelperSpawn) {}
  async open(owner: ComputerUseOwner, limits: ComputerUseDriverLimits, signal: AbortSignal, options?: ComputerUseDriverOpenOptions): Promise<ComputerUseCapability> {
    const identity = validateComputerUseOwner(owner)
    if (options !== undefined && (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).length !== 2 || !Object.hasOwn(options, 'control') || !Object.hasOwn(options, 'captureScope') || !((options.control === true && options.captureScope === 'display') || (options.control === false && options.captureScope === 'window')))) throw new Error('computer-use-scope-unverified')
    if (signal.aborted || this.client || this.closed) throw new Error('computer-use-unavailable')
    if (!Number.isSafeInteger(limits.maxFrameBytes) || limits.maxFrameBytes < 1 || limits.maxFrameBytes > 8 * 1024 * 1024 || !Number.isSafeInteger(limits.maxFramePixels) || limits.maxFramePixels < 1 || limits.maxFramePixels > 8_000_000 || !Number.isSafeInteger(limits.maxFrameEdge) || limits.maxFrameEdge < 1 || limits.maxFrameEdge > 4096) throw new Error('computer-use-budget')
    if (process.platform !== 'linux') return this.unavailable()
    this.control = options?.control === true
    this.client = new ComputerUseHelperClient(this.binary, identity.generation, this.start, this.control, true, this.dmaBufReadback)
    // Subscribe before hello/open can synchronously emit a source revocation.
    this.client.onRevoked(() => {
      if (this.client?.transportUnknown) this.captureUnknown = true
      for (const listener of this.revokedListeners) listener()
    })
    try {
      const hello = await waitForHelper(this.client.request('hello'), signal)
      if (hello.reply.kind !== 'hello' || hello.reply.captureAccountingVersion !== 1 || (this.control && hello.reply.inputProtocolVersion !== 1) || (this.dmaBufReadback && hello.reply.dmaBufReadbackVersion !== 1) || signal.aborted || this.closed) throw new Error('computer-use-unavailable')
      const { reply } = await waitForHelper(this.client.request('open', { ...limits }), signal)
      if (reply.kind !== 'opened' || reply.sourceType !== (this.control ? 1 : 2) || !reply.streamId || signal.aborted || this.closed) throw new Error('computer-use-scope-unverified')
      this.streamId = reply.streamId
      this.limits = { ...limits }
      if (this.control) return { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' }
      return { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'window', unsupportedReason: 'control-unavailable' }
    } catch { throw new Error('computer-use-unavailable') }
  }
  async capture(signal: AbortSignal, limits?: ComputerUseDriverLimits): Promise<ComputerUseDriverFrame> {
    if (signal.aborted || this.closed || this.captureUnknown || !this.client || !this.streamId || !this.limits) throw new Error('computer-use-unavailable')
    const remaining = limits ?? this.limits
    for (const key of ['maxFrameBytes', 'maxFramePixels', 'maxFrameEdge'] as const) {
      if (!Number.isSafeInteger(remaining[key]) || remaining[key] < 1 || remaining[key] > this.limits[key]) throw new Error('computer-use-budget')
    }
    // Do not race cancellation: a physically produced late frame must reach the
    // service's accounting ledger before it rejects delivery to a revoked owner.
    const { reply, bytes, previewPng } = await this.client.request('capture', { ...remaining }).catch(() => {
      this.captureUnknown = true
      throw new Error('computer-use-capture-unknown')
    })
    if (reply.kind === 'error' && reply.noFrameReceipt?.version === 1 && reply.noFrameReceipt.outcome === 'no-complete-png' && !this.client.transportUnknown) throw new Error('computer-use-capture-failed')
    if (reply.kind !== 'frame' || !reply.width || !reply.height || !bytes.length || bytes.length > remaining.maxFrameBytes || reply.width > remaining.maxFrameEdge || reply.height > remaining.maxFrameEdge || reply.width * reply.height > remaining.maxFramePixels) {
      this.captureUnknown = true
      throw new Error('computer-use-capture-unknown')
    }
    if (this.client.transportUnknown) this.captureUnknown = true
    // Header admission only, no Electron/nativeImage decode; the service owns full
    // bounded PNG validation before any external use. Stream type is not PID proof.
    return { deliverable: reply.deliverable, png: Uint8Array.from(bytes), ...(previewPng ? { previewPng: Uint8Array.from(previewPng) } : {}), width: reply.width, height: reply.height, sourceType: this.control ? 'display' : 'window', streamId: this.streamId, ...(reply.inputFrame ? { inputFrame: { ...reply.inputFrame } } : {}) }
  }
  async act(action: ComputerUseAction, frame: ComputerUseNativeInputFence, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed || this.captureUnknown || !this.control || !this.client || !this.streamId) throw new Error('computer-use-unavailable')
    // Do not race abort: actual input is held through its reply and physical close.
    const { reply } = await this.client.act(action, frame)
    if (reply.kind !== 'acted') throw new Error('computer-use-input-failed')
    if (signal.aborted || this.closed) throw new Error('computer-use-interrupted')
  }
  async close(): Promise<void> {
    this.closed = true
    await this.client?.close()
    // Resource closure cannot repair an unaccountable physical frame result.
    if (this.captureUnknown) throw new Error('computer-use-capture-unknown')
  }
  private unavailable(): ComputerUseCapability {
    return { platform: 'linux-wayland', method: 'unavailable', capture: false, control: false, scope: 'unknown-window-or-display', unsupportedReason: 'capture-unavailable' }
  }
}
