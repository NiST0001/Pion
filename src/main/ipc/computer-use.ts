import type { IpcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { validateComputerUseActRequest, validateComputerUseConsent, validateComputerUseRecord, type ComputerUseOwner, type ComputerUseStatus } from '../../shared/computer-use'
import type { ComputerUseService } from '../computer-use/service'
import { captureIpcOwner } from './owner'

/** Service snapshots have already passed validateComputerUseStatus. Omit private
 * identities without parsing the same internal metadata a second time. Full PNGs
 * never enter status; explicit capture returns only its independent preview. */
export function projectComputerUseState(state: ComputerUseStatus): ComputerUseStatus {
  const { owner: _owner, receipt: _receipt, ...result } = state
  return result
}

interface ComputerUseIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  service: Pick<ComputerUseService, 'getState' | 'start' | 'capture' | 'act' | 'stop'>
  getMainWindowId: () => number | undefined
  createLocalOwner: (windowId: number) => ComputerUseOwner
  getLocalOwner: (windowId: number) => ComputerUseOwner
}

export function registerComputerUseIpc({ ipcMain, service, getMainWindowId, createLocalOwner, getLocalOwner }: ComputerUseIpcDependencies): void {
  const noArgs = (args: unknown[]): void => { if (args.length) throw new Error('ComputerUse unexpected arguments') }
  ipcMain.handle(IPC.ComputerUseGetState, (event, ...args: unknown[]) => {
    const assertIpcOwnerCurrent = captureIpcOwner(event, getMainWindowId)
    noArgs(args)
    const state = service.getState()
    assertIpcOwnerCurrent()
    return projectComputerUseState(state)
  })
  ipcMain.handle(IPC.ComputerUseStart, async (event, ...args: unknown[]) => {
    const assertIpcOwnerCurrent = captureIpcOwner(event, getMainWindowId)
    const id = event.sender.id
    if (args.length !== 1) throw new Error('ComputerUse consent required')
    const consent = validateComputerUseConsent(args[0])
    if (!consent.capture || consent.upload || (consent.control ? consent.captureScope !== 'display' : consent.captureScope === 'display')) throw new Error('ComputerUse local capture consent required')
    assertIpcOwnerCurrent()
    const owner = createLocalOwner(id)
    assertIpcOwnerCurrent()
    const starting = service.start(owner, consent)
    const revision = service.getState().scopeRevision
    const state = await starting
    assertIpcOwnerCurrent()
    if (state.scopeRevision !== revision || service.getState().scopeRevision !== revision) throw new Error('ComputerUse stale scope')
    return projectComputerUseState(state)
  })
  ipcMain.handle(IPC.ComputerUseCapture, async (event, ...args: unknown[]) => {
    const assertIpcOwnerCurrent = captureIpcOwner(event, getMainWindowId)
    const id = event.sender.id
    if (args.length !== 1) throw new Error('ComputerUse scope revision required')
    const { scopeRevision: revision } = validateComputerUseRecord(args[0], ['scopeRevision'])
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision !== service.getState().scopeRevision) throw new Error('ComputerUse stale scope')
    const owner = getLocalOwner(id)
    assertIpcOwnerCurrent()
    const result = await service.capture(owner)
    assertIpcOwnerCurrent()
    const current = service.getState()
    if (result.state.scopeRevision !== revision || current.scopeRevision !== revision) throw new Error('ComputerUse stale scope')
    if (current.frame?.id !== result.state.frame?.id) throw new Error('ComputerUse stale frame')
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
  ipcMain.handle(IPC.ComputerUseAct, async (event, ...args: unknown[]) => {
    const assertIpcOwnerCurrent = captureIpcOwner(event, getMainWindowId)
    const id = event.sender.id
    if (args.length !== 1) throw new Error('ComputerUse input request required')
    const copy = validateComputerUseRecord(args[0], ['scopeRevision', 'frameId', 'action'])
    const current = service.getState()
    const revision = copy.scopeRevision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision !== current.scopeRevision || !current.frame) throw new Error('ComputerUse stale scope or frame')
    const action = validateComputerUseActRequest({ frameId: copy.frameId, action: copy.action }, current.frame)
    const owner = getLocalOwner(id)
    assertIpcOwnerCurrent()
    const state = await service.act(owner, action)
    assertIpcOwnerCurrent()
    if (state.scopeRevision !== revision || service.getState().scopeRevision !== revision) throw new Error('ComputerUse stale scope')
    return projectComputerUseState(state)
  })
  ipcMain.handle(IPC.ComputerUseStop, async (event, ...args: unknown[]) => {
    const assertIpcOwnerCurrent = captureIpcOwner(event, getMainWindowId)
    noArgs(args)
    assertIpcOwnerCurrent()
    const state = await service.stop(undefined, 'local-user-stop')
    assertIpcOwnerCurrent()
    return projectComputerUseState(state)
  })
}
