import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { AiSettings, createDeepSeekRuntime, createDeepSeekLlm } from './ai.ts'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, dialog, safeStorage, session as electronSession, shell } from 'electron'
import { API_METHODS } from '../shared/api.ts'
import { createSession, handleCall, setRuntime, setLlmClient, pauseAnalyses, type Session } from './handlers.ts'
import { JsonStore } from './store.ts'

let store: JsonStore
let session: Session

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

  // Never let the app window navigate away or open new windows; send http(s) links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
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

  const dataPath = !app.isPackaged && process.env['NEXUS_DEV_DATA_DIR'] ? process.env['NEXUS_DEV_DATA_DIR'] : app.getPath('userData')
  store = new JsonStore(dataPath)
  const loaded = store.load()
  session = createSession(loaded.db, loaded.currentUserId, (s) =>
    store.save({ db: s.service.db, currentUserId: s.currentUserId })
  )

  session.selectContractFile = async () => {
    const selected = await dialog.showOpenDialog({ title: '导入合同（仅在本机解析）', properties: ['openFile'], filters: [{ name: '合同文件', extensions: ['docx', 'pdf'] }] })
    const file = selected.filePaths[0]
    if (selected.canceled || !file) return null
    if ((await stat(file)).size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后导入')
    return { fileName: basename(file), bytes: await readFile(file) }
  }

  session.aiSettings = new AiSettings(dataPath, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text), decrypt: (bytes) => safeStorage.decryptString(bytes)
  })
  const config = session.aiSettings.load()
  if (config) { setRuntime(createDeepSeekRuntime(config)); setLlmClient(createDeepSeekLlm(config)) }
  session.onWorkflowProgress = (state) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('nexus:workflow-progress', state)
  }
  session.onChatProgress = (event) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('nexus:chat-progress', event)
  }

  ipcMain.handle('nexus:call', (_event, method: unknown, args: unknown) => {
    const list = Array.isArray(args) ? (args as unknown[]) : []
    return handleCall(session, method, list)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => { session?.chatRun?.controller.abort(); if (session) pauseAnalyses(session); store?.flush() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Referenced so the allowlist stays in one place and is visible to bundlers.
void API_METHODS
