import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { selectWindowEffectBackend, WindowEffectsService } from '../../src/main/window-effects'
import type { WindowEffectEnvironment } from '../../src/main/window-effects'

function setup(env: WindowEffectEnvironment, enabled = false, contrast = () => false) {
  const store = { windowEffectsEnabled: enabled, setWindowEffectsEnabled: vi.fn(async (value: boolean, assertCurrent?: () => void) => {
    assertCurrent?.()
    store.windowEffectsEnabled = value
  }) }
  const blur = vi.fn(async () => undefined)
  const service = new WindowEffectsService(store, env, contrast, blur)
  function window(id = 1) {
    const events = new Map<string, () => void>()
    const mock = { isDestroyed: () => false, once: vi.fn((event: string, listener: () => void) => { events.set(event, listener) }), webContents: { id, isDestroyed: () => false, send: vi.fn() },
      setBackgroundColor: vi.fn(), setBackgroundMaterial: vi.fn(), setVibrancy: vi.fn() }
    const win = mock as unknown as BrowserWindow
    service.bind(win)
    return { win, mock, events }
  }
  return { service, store, blur, window }
}

it('selects only supported native APIs and never treats Wayland as X11', () => {
  expect(selectWindowEffectBackend({ platform: 'win32', release: '10.0.19045' })).toBe('unsupported')
  expect(selectWindowEffectBackend({ platform: 'win32', release: '10.0.22621' })).toBe('windows-dwm')
  expect(selectWindowEffectBackend({ platform: 'darwin', release: '25.0' })).toBe('macos-vibrancy')
  const linux = { platform: 'linux', release: '6.1', desktop: 'KDE', sessionType: 'wayland', hasDisplay: true, hasWaylandDisplay: true }
  expect(selectWindowEffectBackend(linux)).toBe('linux-alpha')
  expect(selectWindowEffectBackend({ ...linux, ozonePlatform: 'x11' })).toBe('kwin-x11')
  expect(selectWindowEffectBackend({ ...linux, ozonePlatform: 'wayland' })).toBe('linux-alpha')
  expect(selectWindowEffectBackend({ ...linux, desktop: 'GNOME', ozonePlatform: 'x11' })).toBe('linux-alpha')
})

it('uses DWM without a transparent native window and restores opaque mode', async () => {
  const h = setup({ platform: 'win32', release: '10.0.22621' })
  const { mock } = h.window()
  expect(h.service.windowOptions().transparent).toBe(false)
  expect(await h.service.setEnabled(1, true)).toMatchObject({ active: true, blur: 'native', restartRequired: false })
  expect(mock.setBackgroundMaterial).toHaveBeenCalledWith('acrylic')
  expect(mock.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
  expect(await h.service.setEnabled(1, false)).toMatchObject({ enabled: false, active: false })
  expect(mock.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
  expect(() => h.service.get(99)).toThrow(/主窗口/)
})

it.each(['ipc', 'replacement', 'closed'] as const)('rejects a retired %s owner at the actual asynchronous settings publication', async kind => {
  const h = setup({ platform: 'darwin', release: '25.0' })
  const original = h.window()
  let publish!: () => void
  const pendingWrite = new Promise<void>(resolve => { publish = resolve })
  let current = true
  const assertCurrent = vi.fn(() => { if (!current) throw new Error('IPC owner retired') })
  h.store.setWindowEffectsEnabled.mockImplementationOnce(async (value, assertOwned) => {
    await pendingWrite
    assertOwned?.()
    h.store.windowEffectsEnabled = value
  })
  const pending = h.service.setEnabled(1, true, assertCurrent)
  await vi.waitFor(() => expect(h.store.setWindowEffectsEnabled).toHaveBeenCalledOnce())
  let replacement: ReturnType<typeof h.window> | undefined
  if (kind === 'ipc') current = false
  else if (kind === 'replacement') replacement = h.window()
  else original.events.get('closed')!()
  publish()
  await expect(pending).rejects.toThrow(kind === 'ipc' ? 'IPC owner retired' : /主窗口|窗口已变更/)
  expect(h.store.windowEffectsEnabled).toBe(false)
  expect(original.mock.setVibrancy).not.toHaveBeenCalled()
  expect(original.mock.webContents.send).not.toHaveBeenCalled()
  if (replacement) {
    // The old native window's eventual close must preserve its replacement.
    original.events.get('closed')!()
    expect(h.service.get(1).enabled).toBe(false)
    await expect(h.service.setEnabled(1, true)).resolves.toMatchObject({ enabled: true, active: true })
    expect(replacement.mock.setVibrancy).toHaveBeenCalledWith('under-window')
  }
})

it('rechecks the captured IPC owner when a queued appearance write finally starts', async () => {
  const h = setup({ platform: 'darwin', release: '25.0' })
  h.window()
  let release!: () => void
  const firstWrite = new Promise<void>(resolve => { release = resolve })
  h.store.setWindowEffectsEnabled.mockImplementationOnce(async (value, assertCurrent) => {
    await firstWrite
    assertCurrent?.()
    h.store.windowEffectsEnabled = value
  })
  const first = h.service.setEnabled(1, true)
  let current = true
  const second = h.service.setEnabled(1, false, () => { if (!current) throw new Error('IPC owner retired') })
  await vi.waitFor(() => expect(h.store.setWindowEffectsEnabled).toHaveBeenCalledOnce())
  current = false
  release()
  await first
  await expect(second).rejects.toThrow('IPC owner retired')
  expect(h.store.setWindowEffectsEnabled).toHaveBeenCalledOnce()
  expect(h.store.windowEffectsEnabled).toBe(true)
})

it('uses macOS vibrancy and suppresses it for high contrast without losing preference', async () => {
  let contrast = false
  const h = setup({ platform: 'darwin', release: '25.0' }, true, () => contrast)
  const { mock } = h.window()
  await h.service.refresh()
  expect(mock.setVibrancy).toHaveBeenCalledWith('under-window')
  contrast = true
  await h.service.refresh()
  expect(h.service.get(1)).toMatchObject({ enabled: true, active: false })
  expect(mock.setVibrancy).toHaveBeenLastCalledWith(null)
  contrast = false
  await h.service.refresh()
  expect(h.service.get(1).active).toBe(true)
})

it('requires Linux alpha at creation, requests KWin blur only for X11, and never recreates a window', async () => {
  const h = setup({ platform: 'linux', release: '6.1', desktop: 'KDE', ozonePlatform: 'x11' })
  h.window()
  expect(await h.service.setEnabled(1, true)).toMatchObject({ enabled: true, active: false, restartRequired: true })
  expect(h.blur).not.toHaveBeenCalled()
  expect(h.service.windowOptions().transparent).toBe(true)
  const second = h.window(2)
  await h.service.refresh()
  expect(h.service.get(2)).toMatchObject({ active: true, blur: 'requested', restartRequired: false })
  expect(h.blur).toHaveBeenCalledWith(second.win, true)
  expect(await h.service.setEnabled(2, false)).toMatchObject({ active: false, restartRequired: true })
  expect(second.mock.setBackgroundColor).toHaveBeenLastCalledWith('#14161b')
})

it('falls back to alpha on unsupported compositor blur and to opaque on native API failure', async () => {
  const linux = setup({ platform: 'linux', release: '6.1', desktop: 'KDE', ozonePlatform: 'wayland' }, true)
  linux.window()
  await linux.service.refresh()
  expect(linux.service.get(1)).toMatchObject({ active: true, blur: 'none' })
  expect(linux.blur).not.toHaveBeenCalled()
  const win = setup({ platform: 'win32', release: '10.0.22621' }, true)
  const { mock } = win.window()
  mock.setBackgroundMaterial.mockImplementation(() => { throw new Error('unsupported driver') })
  await win.service.refresh()
  expect(win.service.get(1)).toMatchObject({ active: false, blur: 'none' })
  expect(mock.setBackgroundColor).toHaveBeenLastCalledWith('#14161b')
})
