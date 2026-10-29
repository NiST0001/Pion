import type { ComputerUseAction, ComputerUseCapability, ComputerUseOwner } from '../../shared/computer-use'
import type { ComputerUseDiagnostics } from '../../shared/computer-use-diagnostics'
import type { ComputerUseNativeInputFence } from './input-policy'

export interface ComputerUseDriverOpenOptions { control: boolean; captureScope: 'window' | 'display' }

/** Host-only interface. Constructing a driver must not connect or capture. */
export interface ComputerUseDriverLimits {
  maxFrameBytes: number
  maxFramePixels: number
  maxFrameEdge: number
}

export interface ComputerUseDriverFrame {
  png: Uint8Array
  /** Optional independently encoded bounded display PNG; never the model image. */
  previewPng?: Uint8Array
  width: number
  height: number
  /** Verified portal source type, NOT app/process identity or input authority. */
  sourceType: 'window' | 'display'
  streamId: string
  /** Private native capture/topology fence; never accepted from UI or model. */
  inputFrame?: ComputerUseNativeInputFence
  /** False keeps physical accounting but forbids handing a revoked frame out. */
  deliverable?: boolean
}

export interface ComputerUseDriver {
  /** Starts the OS chooser/session only after consent and durable coordination claim. */
  open(owner: ComputerUseOwner, limits: ComputerUseDriverLimits, signal: AbortSignal, options?: ComputerUseDriverOpenOptions): Promise<ComputerUseCapability>
  /** Remaining per-call limits prevent generation beyond the workflow budget. */
  capture(signal: AbortSignal, limits?: ComputerUseDriverLimits): Promise<ComputerUseDriverFrame>
  /** Complete paired transaction; acknowledgement is not application-semantic success.
   * Missing implementation is unsupported, never a fallback to another input route. */
  act?(action: ComputerUseAction, frame: ComputerUseNativeInputFence, signal: AbortSignal): Promise<void>
  /** Strict void proves the owned Portal session closed by the standard protocol
   * (successful Session.Close, trusted Session.Closed, or explicit disconnection of
   * its exclusive DBus client under the standard client-disappearance lifecycle)
   * and all Pion-owned real requests, PipeWire worker/FDs, helper process/stdio and
   * decodes actually settled, including failed open/capture. With virtual input,
   * all owned keys/buttons/modifiers must also be released and acknowledged,
   * devices destroyed, Wayland references/FDs closed and its worker/watcher joined. It does not certify
   * every internal task/resource of the independent OS Portal/compositor service.
   * Legacy native `closed` retains its Session-close meaning; optional private
   * closeReceipt {version:1,boundary:'client-disconnected'} attests actual exclusive
   * client disconnection plus watcher/PipeWire join, not inferred process absence.
   * Node must still await all normal pending replies, actual decodes and successful
   * zero process/stdio close (not exit). The only no-helper exception is a bound
   * trusted Node ENOENT/EACCES pre-exec failure, verified negative-errno close and
   * all stdio/request settlement with no execution/output or prior poison; it is
   * proof no helper executed, not PID absence or an arbitrary nonzero exit. No receipt resets transport/capture poison,
   * changes a failed start to success, or retrospectively releases old markers.
   * No separate revoked/Closed notice is required after successful Session.Close.
   * ACK alone, errors, timeout, logical abort or
   * watcher unsubscribe cannot prove cleanup. The service additionally waits for
   * its own work/accounting/decode and verified coordination release; this never
   * authorizes clearing an old marker or unknown filesystem ownership. */
  close(): Promise<void>
  /** Pure bounded first-failure cache, not an OS query or stop receipt. */
  getDiagnostics?(): ComputerUseDiagnostics
  /** Passive subscription to authenticated helper/portal revocation notices. */
  onRevoked?(listener: () => void): () => void
}
