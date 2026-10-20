import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session as electronSession, shell, type IpcMainInvokeEvent } from 'electron'
import { API_METHODS } from '../shared/api.ts'
import { createSession, handleCall, type Session } from './handlers.ts'
import { JsonStore } from './store.ts'
import { IdentityBridge } from './identity.ts'
import { LiveSync } from './live.ts'

let store: JsonStore
let session: Session
let live: LiveSync | undefined

function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

function trustedSender(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url.split('#')[0] !== rendererUrl().split('#')[0]) {
    throw new Error('Untrusted IPC sender')
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Project Nexus',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => live?.start())
  win.once('closed', () => { if (BrowserWindow.getAllWindows().length === 0) live?.stop() })

  // Never let the app window navigate away or open new windows; send http(s) links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] === rendererUrl().split('#')[0]) return
    event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function installCsp(): void {
  const dev = !!process.env['ELECTRON_RENDERER_URL']
  const csp = [
    "default-src 'self'",
    // Vite dev server needs inline/eval for HMR; production does not.
    dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
}

app.whenReady().then(() => {
  // Deny every permission request (camera, geolocation, notifications...). The app needs none.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  installCsp()

  // Packaged builds can never enable demo mode, even via a modified environment.
  const demo = !app.isPackaged && process.env.NEXUS_MODE === 'demo'
  const identity = new IdentityBridge(process.env.NEXUS_API_URL, !app.isPackaged, (url) => shell.openExternal(url))
  if (!demo) live = new LiveSync(identity, () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() &&
        win.webContents.getURL().split('#')[0] === rendererUrl().split('#')[0]) win.webContents.send('nexus:invalidate')
    }
  })
  if (demo) {
    store = new JsonStore(join(app.getPath('userData'), 'demo'))
    const loaded = store.load()
    session = createSession(loaded.db, loaded.currentUserId, (s) =>
      store.save({ db: s.service.db, currentUserId: s.currentUserId })
    )
  }
  ipcMain.handle('nexus:mode', (event) => { trustedSender(event); return demo ? 'demo' : 'server' })
  ipcMain.handle('nexus:identity', (event, action: unknown, body: unknown) => {
    trustedSender(event)
    return identity.identity(action, body)
  })
  ipcMain.handle('nexus:call', (event, method: unknown, args: unknown) => {
    trustedSender(event)
    const list = Array.isArray(args) ? (args as unknown[]) : []
    return demo ? handleCall(session, method, list) : identity.business(method, list)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => { live?.stop(); store?.flush() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Referenced so the allowlist stays in one place and is visible to bundlers.
void API_METHODS
