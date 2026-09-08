import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { selectWindowEffectBackend, WindowEffectsService } from '../../src/main/window-effects'
import type { WindowEffectEnvironment } from '../../src/main/window-effects'

function setup(env: WindowEffectEnvironment, enabled = false, contrast = () => false) {
  const store = { windowEffectsEnabled: enabled, setWindowEffectsEnabled: vi.fn(async (value: boolean) => { store.windowEffectsEnabled = value }) }
  const blur = vi.fn(async () => undefined)
  const service = new WindowEffectsService(store, env, contrast, blur)
  function window(id = 1) {
    const mock = { isDestroyed: () => false, once: vi.fn(), webContents: { id, isDestroyed: () => false, send: vi.fn() },
      setBackgroundColor: vi.fn(), setBackgroundMaterial: vi.fn(), setVibrancy: vi.fn() }
    const win = mock as unknown as BrowserWindow
    service.bind(win)
    return { win, mock }
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
