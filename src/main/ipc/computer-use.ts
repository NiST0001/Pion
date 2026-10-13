import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import { validateComputerUseConsent, validateComputerUseStatus, type ComputerUseOwner, type ComputerUseStatus } from '../../shared/computer-use'
import type { ComputerUseService } from '../computer-use/service'

/** Each invocation, including completion, must still belong to the live main frame. */
export function assertComputerUseIpcOwner(event: IpcMainInvokeEvent, ownerId: number | undefined): void {
  if (ownerId === undefined || event.sender.isDestroyed() || event.sender.id !== ownerId || !event.senderFrame || event.senderFrame.detached || event.senderFrame !== event.sender.mainFrame) throw new Error('ComputerUse owner unavailable')
}

/** Status metadata only: no full PNG, model image, SDK identity or raw diagnostics.
 * Independently bounded display PNGs are returned only by explicit capture. */
export function projectComputerUseState(state: ComputerUseStatus): ComputerUseStatus {
  const result = validateComputerUseStatus(state)
  delete result.owner
  delete result.receipt
  return result
}

interface ComputerUseIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  service: Pick<ComputerUseService, 'getState' | 'start' | 'capture' | 'stop'>
  getMainWindowId: () => number | undefined
  createLocalOwner: (windowId: number) => ComputerUseOwner
  getLocalOwner: (windowId: number) => ComputerUseOwner
}

export function registerComputerUseIpc({ ipcMain, service, getMainWindowId, createLocalOwner, getLocalOwner }: ComputerUseIpcDependencies): void {
  const check = (event: IpcMainInvokeEvent): number => {
    const id = getMainWindowId()
    assertComputerUseIpcOwner(event, id)
    return id!
  }
  const noArgs = (args: unknown[]): void => { if (args.length) throw new Error('ComputerUse unexpected arguments') }
  ipcMain.handle(IPC.ComputerUseGetState, (event, ...args: unknown[]) => {
    check(event); noArgs(args)
    return projectComputerUseState(service.getState())
  })
  ipcMain.handle(IPC.ComputerUseStart, async (event, ...args: unknown[]) => {
    const id = check(event)
    if (args.length !== 1) throw new Error('ComputerUse consent required')
    const consent = validateComputerUseConsent(args[0])
    if (!consent.capture || consent.upload || consent.control) throw new Error('ComputerUse local capture consent required')
    const owner = createLocalOwner(id)
    const state = await service.start(owner, consent)
    check(event)
    return projectComputerUseState(state)
  })
  ipcMain.handle(IPC.ComputerUseCapture, async (event, ...args: unknown[]) => {
    const id = check(event)
    const request = args[0]
    if (args.length !== 1 || !request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype || Reflect.ownKeys(request).length !== 1) throw new Error('ComputerUse scope revision required')
    const descriptor = Object.getOwnPropertyDescriptor(request, 'scopeRevision')
    const revision: unknown = descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision !== service.getState().scopeRevision) throw new Error('ComputerUse stale scope')
    const owner = getLocalOwner(id)
    const result = await service.capture(owner)
    check(event)
    if (result.state.scopeRevision !== revision || service.getState().scopeRevision !== revision) throw new Error('ComputerUse stale scope')
    if (service.getState().frame?.id !== result.state.frame?.id) throw new Error('ComputerUse stale frame')
    if (!result.previewPng) return { state: projectComputerUseState(result.state), previewUnavailable: 'thumbnail-not-supported' as const }
    // The broker has already validated this separate PNG while holding its slot.
    // Repeat display bounds; do not decode or transfer the full model attachment.
    const bytes = result.previewPng
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 57 || bytes.byteLength > 96 * 1024) throw new Error('ComputerUse preview unavailable')
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('ComputerUse preview unavailable')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (width < 1 || height < 1 || width > 512 || height > 512) throw new Error('ComputerUse preview unavailable')
    return { state: projectComputerUseState(result.state), preview: `data:image/png;base64,${png.toString('base64')}` }
  })
  ipcMain.handle(IPC.ComputerUseStop, async (event, ...args: unknown[]) => {
    check(event); noArgs(args)
    const state = await service.stop(undefined, 'local-user-stop')
    check(event)
    return projectComputerUseState(state)
  })
}
