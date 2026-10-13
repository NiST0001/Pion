import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService } from '../../src/main/computer-use/service'
import { sameComputerUseOwner } from '../../src/shared/computer-use'
import { projectComputerUseState } from '../../src/main/ipc/computer-use'

const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
// Execute the actual host ledger + wiring without importing index's app/bootstrap
// side effects. No Electron window, portal, helper, SDK or image decoder is started.
const hostSource = source.slice(source.indexOf('let mainWindowId:'), source.indexOf('const windowEffects ='))
const hostJs = transpileModule(hostSource, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText
const consent = { capture: true, upload: false, control: false, retention: 'sdk-session' as const }
const capability = { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'window', unsupportedReason: 'control-unavailable' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(options: { open?: Promise<unknown>; close?: Promise<unknown> } = {}) {
  const windows: Array<{ isDestroyed: () => boolean; webContents: ReturnType<typeof makeContents> }> = []
  const driver = { open: vi.fn(() => options.open ?? Promise.resolve(capability)), close: vi.fn(() => options.close ?? Promise.resolve()), capture: vi.fn() }
  let id = 0
  const host = new Function('BrowserWindow', 'ComputerUseService', 'WaylandComputerUseDriver', 'sameComputerUseOwner', 'randomUUID', 'performance', 'app', 'process', 'join', 'IPC_EVENTS', 'projectComputerUseState', 'console', `${hostJs}
    return { bind(contents) { mainWindowId = contents.id; bindCaptureDocument(contents) },
      create: createLocalCaptureOwner, getOwner: requireLocalCaptureOwner, service: computerUse,
      stop: stopLocalCapture, document: () => captureDocument,
      beginQuit() { computerUseQuitting = true } };
  `)(
    { getAllWindows: () => windows }, ComputerUseService, function () { return driver }, sameComputerUseOwner,
    () => `id-${++id}`, { now: () => 1 }, { isPackaged: false, getAppPath: () => '/fake' }, { platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' } }, join,
    { ComputerUseState: 'state' }, projectComputerUseState, { error: vi.fn() }
  )
  const addWindow = (windowId: number) => {
    const contents = makeContents(windowId)
    windows.push({ isDestroyed: () => false, webContents: contents })
    host.bind(contents)
    return contents
  }
  const contents = addWindow(7)
  const finish = () => contents.emit('did-finish-load')
  const start = () => host.service.start(host.create(contents.id), consent)
  return { host, driver, contents, finish, start, addWindow }
}
function makeContents(id: number) {
  return Object.assign(new EventEmitter(), { id, mainFrame: { detached: false }, isDestroyed: () => false, send: vi.fn() })
}
function navigate(contents: ReturnType<typeof makeContents>, extra = {}) {
  contents.emit('did-start-navigation', { url: 'file:///new.html', isMainFrame: true, isSameDocument: false, frame: contents.mainFrame, ...extra }, 'deprecated', true, false, -1, -1)
}

describe('ComputerUse host document ownership (mock only)', () => {
  it('wires the ledger before host load and both IPC owner callbacks use it', () => {
    expect(source.indexOf('bindCaptureDocument(win.webContents)')).toBeLessThan(source.indexOf('void win.loadURL('))
    expect(source).toContain('createLocalOwner: createLocalCaptureOwner')
    expect(source).toContain('getLocalOwner: requireLocalCaptureOwner')
    expect(source).toContain('const approvedOwner = requireLocalCaptureOwner(owner.ownerWindowId)')
  })

  it('initial uncommitted document cannot approve or start a helper', () => {
    const h = harness()
    expect(() => h.host.create(7)).toThrow('document unavailable')
    expect(h.driver.open).not.toHaveBeenCalled()
    h.finish()
    const owner = h.host.create(7)
    expect(h.host.getOwner(7)).toEqual(owner)
    expect(() => h.host.getOwner(8)).toThrow()
  })

  it('same-document anchors and subframe navigation preserve approval', async () => {
    const h = harness(); h.finish(); await h.start()
    const owner = h.host.getOwner(7)
    navigate(h.contents, { isSameDocument: true })
    navigate(h.contents, { isMainFrame: false })
    navigate(h.contents, { frame: { detached: false } })
    expect(h.host.getOwner(7)).toEqual(owner)
    expect(h.driver.close).not.toHaveBeenCalled()
  })

  it('reload on the same WC id revokes synchronously; unknown close retains physical quarantine', async () => {
    const close = deferred<unknown>()
    const h = harness({ close: close.promise }); h.finish(); await h.start()
    const old = h.host.getOwner(7)
    const revision = h.host.service.getState().scopeRevision
    navigate(h.contents)
    expect(() => h.host.getOwner(7)).toThrow()
    expect(h.host.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true, consent: { capture: false } })
    h.finish()
    // Knowing current scopeRevision on a new document cannot recover approval.
    expect(h.host.service.getState().scopeRevision).toBeGreaterThan(revision)
    expect(() => h.host.getOwner(7)).toThrow()
    expect(() => h.host.create(7)).toThrow('lease occupied')
    await expect(h.host.service.capture(old)).rejects.toThrow()
    close.resolve({ unknown: true })
    await h.host.stop(7)
    expect(h.host.service.getState()).toMatchObject({ state: 'quarantined', actualPending: true })
    expect(() => h.host.create(7)).toThrow('lease occupied')
    expect(h.driver.open).toHaveBeenCalledTimes(1)
    expect(h.driver.close).toHaveBeenCalledTimes(1)
  })

  it('will-navigate and did-start-navigation cannot grant between duplicate notifications', async () => {
    const h = harness(); h.finish(); await h.start()
    const old = h.host.getOwner(7)
    h.contents.emit('will-navigate', { url: 'file:///replacement.html', isMainFrame: true })
    expect(() => h.host.create(7)).toThrow('document unavailable')
    navigate(h.contents)
    await h.host.stop(7)
    h.contents.mainFrame = { detached: false }
    h.finish()
    const fresh = h.host.create(7)
    expect(fresh.runtimeId).not.toBe(old.runtimeId)
    expect(fresh.generation).toBeGreaterThan(old.generation)
    expect(h.host.getOwner(7)).toEqual(fresh)
  })

  it('late old open cannot publish pixels or clear a newly approved document', async () => {
    const open = deferred<unknown>()
    const h = harness({ open: open.promise }); h.finish()
    const pending = h.start()
    const rejected = expect(pending).rejects.toThrow('revoked')
    await Promise.resolve()
    h.contents.send.mockClear()
    navigate(h.contents); h.finish()
    expect(() => h.host.create(7)).toThrow('lease occupied')
    open.resolve(capability)
    await rejected
    await h.host.stop(7)
    const fresh = h.host.create(7)
    await Promise.resolve()
    expect(h.host.getOwner(7)).toEqual(fresh)
    // New documents may read redacted stopping status, never old pixels/grants.
    for (const [, status] of h.contents.send.mock.calls) {
      expect(status).not.toHaveProperty('owner')
      expect(status).not.toHaveProperty('frame')
      expect(status).not.toHaveProperty('png')
    }
  })

  it('host revocation and quitting still publish redacted stopping status without approving capture', async () => {
    const close = deferred<unknown>()
    const h = harness({ close: close.promise }); h.finish(); await h.start()
    h.contents.send.mockClear()
    h.host.beginQuit()
    const stopping = h.host.stop(7)
    expect(() => h.host.create(7)).toThrow('document unavailable')
    expect(h.contents.send).toHaveBeenCalledWith('state', expect.objectContaining({ state: 'quarantined', actualPending: true }))
    const [, status] = h.contents.send.mock.calls.at(-1)!
    expect(status).not.toHaveProperty('owner')
    expect(status).not.toHaveProperty('receipt')
    close.resolve(undefined)
    await stopping
    expect(h.contents.send).toHaveBeenLastCalledWith('state', expect.objectContaining({ state: 'stopped', actualPending: false }))
  })

  it('frame replacement or detachment rejects approval even before navigation notification', () => {
    const h = harness(); h.finish(); h.host.create(7)
    h.contents.mainFrame.detached = true
    expect(() => h.host.getOwner(7)).toThrow('document unavailable')
    h.contents.mainFrame = { detached: false }
    expect(() => h.host.getOwner(7)).toThrow('document unavailable')
  })

  it('old window lifecycle callbacks cannot revoke the active window document', () => {
    const h = harness(); h.finish(); h.host.create(7)
    const peer = h.addWindow(9); peer.emit('did-finish-load')
    const fresh = h.host.create(9)
    h.contents.emit('destroyed')
    h.contents.emit('render-process-gone', {}, { reason: 'crashed' })
    navigate(h.contents)
    expect(h.host.getOwner(9)).toEqual(fresh)
    expect(() => h.host.getOwner(7)).toThrow()
  })
})
