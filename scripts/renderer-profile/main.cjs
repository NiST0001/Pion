'use strict'

// Standalone, disposable renderer host. This process intentionally imports no Pion code.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const root = fs.realpathSync(process.env.PROFILE_BUILD_ROOT)
const entry = fs.realpathSync(process.env.PROFILE_ENTRY)
const userData = process.env.PROFILE_USER_DATA
if (!userData || !entry.startsWith(root + path.sep)) throw new Error('Invalid profile paths')
app.setPath('userData', userData)
app.commandLine.appendSwitch('ozone-platform', 'wayland')

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'"
function allowed(raw) {
  if (raw.startsWith('data:')) return raw.length <= 1024 * 1024
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:' || url.hostname || url.search) return false
    const real = fs.realpathSync(fileURLToPath(url))
    const stat = fs.statSync(real)
    return real.startsWith(root + path.sep) && stat.isFile() && stat.size <= 64 * 1024 * 1024
  } catch { return false }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('profile-renderer')
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }))
  ses.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
  }))
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  const win = new BrowserWindow({
    width: 1280, height: 820, show: true,
    webPreferences: {
      session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, backgroundThrottling: false
    }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  await win.loadFile(entry)
}).catch((error) => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
