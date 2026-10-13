// SPDX-License-Identifier: MIT
import type { ComputerUseCapability, ComputerUseOwner } from '../../shared/computer-use'
import { validateComputerUseOwner } from '../../shared/computer-use'
import type { ComputerUseDriver, ComputerUseDriverFrame, ComputerUseDriverLimits } from './driver'
import { ComputerUseHelperClient, waitForHelper, type HelperSpawn } from './helper-client'

/** Explicit absolute project helper path; no probing, chooser or spawn in constructor. */
export class WaylandComputerUseDriver implements ComputerUseDriver {
  private client?: ComputerUseHelperClient
  private closed = false
  private captureUnknown = false
  private streamId?: string
  private limits?: ComputerUseDriverLimits
  private readonly revokedListeners = new Set<() => void>()
  onRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener)
    return () => { this.revokedListeners.delete(listener) }
  }
  constructor(private readonly binary: string, private readonly start?: HelperSpawn) {}
  async open(owner: ComputerUseOwner, limits: ComputerUseDriverLimits, signal: AbortSignal): Promise<ComputerUseCapability> {
    const identity = validateComputerUseOwner(owner)
    if (signal.aborted || this.client || this.closed) throw new Error('computer-use-unavailable')
    if (!Number.isSafeInteger(limits.maxFrameBytes) || limits.maxFrameBytes < 1 || limits.maxFrameBytes > 8 * 1024 * 1024 || !Number.isSafeInteger(limits.maxFramePixels) || limits.maxFramePixels < 1 || limits.maxFramePixels > 8_000_000 || !Number.isSafeInteger(limits.maxFrameEdge) || limits.maxFrameEdge < 1 || limits.maxFrameEdge > 4096) throw new Error('computer-use-budget')
    if (process.platform !== 'linux') return this.unavailable()
    this.client = new ComputerUseHelperClient(this.binary, identity.generation, this.start)
    // Subscribe before hello/open can synchronously emit a source revocation.
    this.client.onRevoked(() => {
      if (this.client?.transportUnknown) this.captureUnknown = true
      for (const listener of this.revokedListeners) listener()
    })
    try {
      const hello = await waitForHelper(this.client.request('hello'), signal)
      if (hello.reply.kind !== 'hello' || signal.aborted || this.closed) throw new Error('computer-use-unavailable')
      const { reply } = await waitForHelper(this.client.request('open', { ...limits }), signal)
      if (reply.kind !== 'opened' || reply.sourceType !== 2 || !reply.streamId || signal.aborted || this.closed) throw new Error('computer-use-scope-unverified')
      this.streamId = reply.streamId
      this.limits = { ...limits }
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
    if (reply.kind !== 'frame' || !reply.width || !reply.height || !bytes.length || bytes.length > remaining.maxFrameBytes || reply.width > remaining.maxFrameEdge || reply.height > remaining.maxFrameEdge || reply.width * reply.height > remaining.maxFramePixels) {
      this.captureUnknown = true
      throw new Error('computer-use-capture-unknown')
    }
    if (this.client.transportUnknown) this.captureUnknown = true
    // Header admission only, no Electron/nativeImage decode; the service owns full
    // bounded PNG validation before any external use. Stream type is not PID proof.
    return { deliverable: reply.deliverable, png: Uint8Array.from(bytes), ...(previewPng ? { previewPng: Uint8Array.from(previewPng) } : {}), width: reply.width, height: reply.height, sourceType: 'window', streamId: this.streamId }
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
