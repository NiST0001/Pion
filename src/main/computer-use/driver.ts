import type { ComputerUseCapability, ComputerUseOwner } from '../../shared/computer-use'

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
  sourceType: 'window'
  streamId: string
  /** False keeps physical accounting but forbids handing a revoked frame out. */
  deliverable?: boolean
}

export interface ComputerUseDriver {
  /** Starts the OS chooser/session only after the service admits capture consent. */
  open(owner: ComputerUseOwner, limits: ComputerUseDriverLimits, signal: AbortSignal): Promise<ComputerUseCapability>
  /** Remaining per-call limits prevent generation beyond the workflow budget. */
  capture(signal: AbortSignal, limits?: ComputerUseDriverLimits): Promise<ComputerUseDriverFrame>
  /** Must await real pending and session/helper closure. A timeout is not closure. */
  close(): Promise<void>
  /** Passive subscription to authenticated helper/portal revocation notices. */
  onRevoked?(listener: () => void): () => void
}
