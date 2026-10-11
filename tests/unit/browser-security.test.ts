import { EventEmitter } from 'node:events'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { BROWSER_BLANK_URL, BROWSER_PARTITION, BROWSER_URL_MAX_LENGTH, isAllowedBrowserUrl, normalizeBrowserUrl } from '../../src/shared/browser'

describe('isolated browser security suites', () => {
const electron = { fromPartition: vi.fn(), fromWebContents: vi.fn() }
let bindBrowserSecurity: typeof import('../../src/main/browser-security')['bindBrowserSecurity']
beforeAll(async () => {
  vi.resetModules()
  vi.doMock('electron', () => ({ session: { fromPartition: electron.fromPartition }, BrowserWindow: { fromWebContents: electron.fromWebContents } }))
  try {
    ;({ bindBrowserSecurity } = await import('../../src/main/browser-security'))
  } finally {
    vi.doUnmock('electron')
    vi.resetModules()
  }
})

function setup() {
  let preloadScripts = [{ id: 'unsafe', filePath: '/pion/preload.js', type: 'frame' }]
  let nextGuestId = 100
  const ses = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    getPreloadScripts: vi.fn(() => preloadScripts),
    unregisterPreloadScript: vi.fn((id: string) => { preloadScripts = preloadScripts.filter(script => script.id !== id) })
  })
  electron.fromPartition.mockReturnValue(ses)
  const host = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, getType: (): string => 'window', hostWebContents: null })
  const win = Object.assign(new EventEmitter(), { webContents: host, isDestroyed: () => false })
  electron.fromWebContents.mockReturnValue(win)
  bindBrowserSecurity(win as unknown as BrowserWindow)
  function attach(src = 'https://example.org/', partition = BROWSER_PARTITION) {
    const event = { preventDefault: vi.fn() }
    const prefs: Record<string, unknown> = { preload: '/pion/preload.js', preloadURL: 'file:///evil.js', session: {}, nodeIntegration: true, sandbox: false, webSecurity: false, enableBlinkFeatures: 'dangerous' }
    const params: Record<string, string> = { src, partition, preload: 'file:///evil.js', webpreferences: 'nodeIntegration=yes', allowpopups: '' }
    host.emit('will-attach-webview', event, prefs, params)
    return { event, prefs, params }
  }
  function guest(options: Record<string, unknown> = {}) {
    const g = Object.assign(new EventEmitter(), {
      id: nextGuestId++, getType: () => 'webview', hostWebContents: host, session: ses,
      isDestroyed: () => false, getURL: () => 'https://example.org/', close: vi.fn(), setWindowOpenHandler: vi.fn(), ...options
    })
    host.emit('did-attach-webview', {}, g)
    return g
  }
  return { win, host, ses, attach, guest }
}

describe('browser URL contract', () => {
  it('normalizes only address-bar input', () => {
    expect(normalizeBrowserUrl(' example.org ')).toBe('https://example.org/')
    expect(normalizeBrowserUrl('example.org:8080/path')).toBe('https://example.org:8080/path')
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserUrl('127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a')
    expect(normalizeBrowserUrl(BROWSER_BLANK_URL)).toBe(BROWSER_BLANK_URL)
    expect(isAllowedBrowserUrl('example.org')).toBe(false)
  })
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'mailto:a@b.test', 'about:config', 'about:blank#evil', 'https://user:pass@site.test', 'https://@site.test', 'https://site.test/\n', 'https://site.test/\\evil', 'x'.repeat(BROWSER_URL_MAX_LENGTH + 1)])('rejects unsafe URL %s', (url) => {
    expect(isAllowedBrowserUrl(url)).toBe(false)
    // Trimming whitespace is an intentional address-bar convenience.
    if (!url.endsWith('\n')) expect(normalizeBrowserUrl(url)).toBeNull()
  })
})

it('strips all preload/session overrides and locks security flags without any guest Pion API', () => {
  const h = setup()
  const { event, prefs, params } = h.attach()
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(prefs).toMatchObject({ partition: BROWSER_PARTITION, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, plugins: false, experimentalFeatures: false })
  for (const key of ['preload', 'preloadURL', 'session', 'enableBlinkFeatures']) expect(prefs).not.toHaveProperty(key)
  for (const key of ['preload', 'webpreferences', 'allowpopups']) expect(params).not.toHaveProperty(key)
  expect(h.ses.unregisterPreloadScript).toHaveBeenCalledWith('unsafe')
  expect(electron.fromPartition).toHaveBeenLastCalledWith('pion-browser')
  h.ses.getPreloadScripts.mockReturnValue([{ id: 'late', filePath: '/late.js', type: 'frame' }])
  expect(h.attach().event.preventDefault).toHaveBeenCalled()
})

it('rejects foreign partitions, URLs, non-window/guest hosts and foreign owners', () => {
  const h = setup()
  for (const partition of ['', 'persist:pion-browser', 'default']) expect(h.attach('https://site.test', partition).event.preventDefault).toHaveBeenCalled()
  expect(h.attach('file:///evil').event.preventDefault).toHaveBeenCalled()
  electron.fromWebContents.mockReturnValue({})
  expect(h.attach().event.preventDefault).toHaveBeenCalled()
  electron.fromWebContents.mockReturnValue(h.win)
  h.host.getType = () => 'webview'
  expect(h.attach().event.preventDefault).toHaveBeenCalled()
})

it('preserves the existing plugin-store guest without initializing or changing its session handlers early', () => {
  const h = setup()
  expect(electron.fromPartition).toHaveBeenLastCalledWith(BROWSER_PARTITION)
  const pluginSession = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  electron.fromPartition.mockImplementation((partition: string) => partition === 'persist:pion-plugin-store' ? pluginSession : h.ses)
  const attachment = h.attach('https://pi.dev/packages', 'persist:pion-plugin-store')
  expect(attachment.event.preventDefault).not.toHaveBeenCalled()
  expect(attachment.prefs).toMatchObject({ partition: 'persist:pion-plugin-store', nodeIntegration: false, sandbox: true })
  expect(attachment.prefs).not.toHaveProperty('preload')
  const guest = h.guest({ session: pluginSession, getURL: () => '' })
  expect(guest.close).not.toHaveBeenCalled()
  expect(pluginSession.setPermissionRequestHandler).not.toHaveBeenCalled()
  expect(pluginSession.setPermissionCheckHandler).not.toHaveBeenCalled()
  h.win.emit('hide')
  expect(guest.close).not.toHaveBeenCalled()
})

it('gates every navigation/redirect including subframes, denies popup and nested webview', () => {
  const h = setup()
  const g = h.guest()
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    const bad = { url: 'javascript:alert(1)', preventDefault: vi.fn() }
    g.emit(name, bad)
    expect(bad.preventDefault).toHaveBeenCalled()
    const good = { url: 'https://site.test/path', preventDefault: vi.fn() }
    g.emit(name, good)
    expect(good.preventDefault).not.toHaveBeenCalled()
  }
  const popup = g.setWindowOpenHandler.mock.calls[0][0]
  expect(popup({ url: 'https://site.test' })).toEqual({ action: 'deny' })
  const nested = { preventDefault: vi.fn() }
  g.emit('will-attach-webview', nested)
  expect(nested.preventDefault).toHaveBeenCalled()
})

it('denies permissions/checks/downloads on the dedicated session only', () => {
  const h = setup()
  const callback = vi.fn()
  h.ses.setPermissionRequestHandler.mock.calls[0][0](null, 'openExternal', callback)
  expect(callback).toHaveBeenCalledWith(false)
  expect(h.ses.setPermissionCheckHandler.mock.calls[0][0](null, 'media')).toBe(false)
  const event = { preventDefault: vi.fn() }
  h.ses.emit('will-download', event)
  expect(event.preventDefault).toHaveBeenCalled()
})

it('rejects wrong-session/foreign-host guests and closes owned guests only on owner destruction', () => {
  const h = setup()
  expect(h.guest({ session: {} }).close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  expect(h.guest({ hostWebContents: {} }).close).toHaveBeenCalled()
  const g = h.guest()
  h.win.emit('hide')
  expect(g.close).not.toHaveBeenCalled()
  h.win.emit('closed')
  expect(g.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  expect(h.guest().close).toHaveBeenCalled()
})

it('backs navigation events with request gating for programmatic loads and dead/unknown owners', () => {
  const h = setup()
  const g = h.guest()
  const gate = h.ses.webRequest.onBeforeRequest.mock.calls[0][1]
  const check = (url: string, resourceType = 'mainFrame', webContentsId = g.id) => {
    const callback = vi.fn()
    gate({ url, resourceType, webContentsId }, callback)
    return callback.mock.calls[0][0].cancel
  }
  expect(check('https://site.test')).toBe(false)
  expect(check('file:///secret', 'subFrame')).toBe(true)
  expect(check('https://site.test', 'mainFrame', -1)).toBe(true)
  expect(check('https://site.test/image.png', 'image')).toBe(false)
  h.win.emit('closed')
  expect(check('https://site.test')).toBe(true)
})

it('binds idempotently and exposes no IPC invoke handler or Pion preload to guests', () => {
  const h = setup()
  const count = h.host.listenerCount('will-attach-webview')
  bindBrowserSecurity(h.win as unknown as BrowserWindow)
  expect(h.host.listenerCount('will-attach-webview')).toBe(count)
  const { prefs } = h.attach()
  expect(prefs.preload).toBeUndefined()
  expect(prefs.nodeIntegration).toBe(false)
  // No new IPC/preload bridge is added here. Mock preferences are not proof
  // of the real guest's JavaScript globals or all existing IPC owner checks.
  const g = h.guest()
  expect(g.session as unknown as Session).toBe(h.ses)
  expect(g.hostWebContents as unknown as WebContents).toBe(h.host)
})
})
