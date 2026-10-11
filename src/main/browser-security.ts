import { BrowserWindow, session, type Session, type WebContents } from 'electron'
import { BROWSER_PARTITION, isAllowedBrowserUrl } from '../shared/browser'

const bound = new WeakSet<BrowserWindow>()
const securedSessions = new WeakSet<Session>()
const owners = new Map<number, { guest: WebContents; alive: () => boolean }>()

function secureSession(browserSession: Session): void {
  if (securedSessions.has(browserSession)) return
  // This module exclusively owns this partition's handlers; never use defaultSession.
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.on('will-download', (event) => event.preventDefault())
  // Navigation events exclude programmatic loadURL/back. Also gate network frame
  // requests, including redirects, without prohibiting ordinary website assets.
  browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const owner = details.webContentsId === undefined ? undefined : owners.get(details.webContentsId)
    const frame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    callback({ cancel: frame && (!owner?.alive() || !isAllowedBrowserUrl(details.url)) })
  })
  // Session-level preloads would otherwise bypass stripped webview attributes.
  for (const script of browserSession.getPreloadScripts()) browserSession.unregisterPreloadScript(script.id)
  securedSessions.add(browserSession)
}

/** Bind once, after app.ready and BEFORE loading the trusted main-window UI. */
export function bindBrowserSecurity(win: BrowserWindow): void {
  if (bound.has(win)) return
  const host = win.webContents
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  secureSession(browserSession)
  bound.add(win)
  let closed = false
  // Existing plugin-store browsing keeps its separate persistent session and
  // lifecycle. Do not initialize it merely by opening the main window.
  let pluginStoreSession: Session | undefined
  const guests = new Set<WebContents>()
  const alive = (): boolean => !closed && !win.isDestroyed() && !host.isDestroyed()
  const mainHost = (): boolean => alive() && host.getType() === 'window' && !host.hostWebContents && BrowserWindow.fromWebContents(host) === win
  const closeGuest = (guest: WebContents): void => {
    if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
  }

  host.on('will-attach-webview', (event, preferences, params) => {
    // Electron exposes no originating senderFrame in this event. Validate the
    // actual emitter (main window, not a guest); guest nesting is separately denied.
    const pluginStore = params.partition === 'persist:pion-plugin-store'
    if (!mainHost() || (!pluginStore && params.partition !== BROWSER_PARTITION)
      || !isAllowedBrowserUrl(params.src)
      || (!pluginStore && browserSession.getPreloadScripts().length !== 0)) {
      event.preventDefault()
      return
    }
    if (pluginStore) pluginStoreSession = session.fromPartition('persist:pion-plugin-store')
    // Keep Electron's internal guest bookkeeping, but remove all caller-controlled
    // paths/session overrides and feature switches before imposing safe preferences.
    for (const key of ['preload', 'preloadURL', 'session', 'additionalArguments', 'enableBlinkFeatures', 'disableBlinkFeatures']) {
      delete (preferences as Record<string, unknown>)[key]
    }
    for (const key of ['preload', 'preloadURL', 'preloadurl', 'webpreferences', 'allowpopups', 'nodeintegration', 'nodeintegrationinsubframes', 'disablewebsecurity', 'plugins', 'blinkfeatures', 'disableblinkfeatures']) delete params[key]
    Object.assign(preferences, {
      partition: params.partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      safeDialogs: true
    })
  })

  host.on('did-attach-webview', (_event, guest) => {
    // The pre-existing plugin-store guest has no browser owner/request gate;
    // keep its own lifecycle and do not change its session's handlers.
    if (mainHost() && guest.getType() === 'webview' && guest.hostWebContents === host
      && pluginStoreSession && guest.session === pluginStoreSession
      && (guest.getURL() === '' || isAllowedBrowserUrl(guest.getURL()))) return
    if (!mainHost() || guest.getType() !== 'webview' || guest.hostWebContents !== host || guest.session !== browserSession ||
        (guest.getURL() !== '' && !isAllowedBrowserUrl(guest.getURL()))) {
      closeGuest(guest)
      return
    }
    guests.add(guest)
    owners.set(guest.id, { guest, alive })
    guest.once('destroyed', () => { guests.delete(guest); owners.delete(guest.id) })
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-attach-webview', (event) => event.preventDefault())
    guest.on('will-navigate', (event) => {
      if (!alive() || !isAllowedBrowserUrl(event.url)) event.preventDefault()
    })
    guest.on('will-frame-navigate', (event) => {
      if (!alive() || !isAllowedBrowserUrl(event.url)) event.preventDefault()
    })
    guest.on('will-redirect', (event) => {
      if (!alive() || !isAllowedBrowserUrl(event.url)) event.preventDefault()
    })
    // No guest preload, contextBridge, Pion IPC channel or external-shell handler.
  })

  const cleanup = (): void => {
    closed = true
    for (const guest of guests) {
      owners.delete(guest.id)
      closeGuest(guest)
    }
    guests.clear()
  }
  win.once('closed', cleanup)
  host.once('destroyed', cleanup)
  // Hiding a dock panel does not call cleanup or destroy its guest.
}
