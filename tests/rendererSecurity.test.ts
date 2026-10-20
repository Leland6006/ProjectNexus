import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isTrustedRendererUrl } from '../src/main/rendererSecurity.ts'

const devUrl = 'http://localhost:5173'

test('renderer URL comparison accepts browser-normalized roots and hash routing', () => {
  assert.equal(isTrustedRendererUrl(`${devUrl}/`, devUrl), true)
  assert.equal(isTrustedRendererUrl(`${devUrl}/#contracts`, devUrl), true)
  assert.equal(isTrustedRendererUrl('https://LOCALHOST:443/#home', 'https://localhost'), true)
  assert.equal(
    isTrustedRendererUrl('file:///C:/Nexus/index.html#home', 'file:///C:/Nexus/index.html'),
    true
  )
})

test('renderer URL comparison rejects other origins, documents, queries and invalid URLs', () => {
  for (const actual of [
    'http://localhost:5174/',
    'http://127.0.0.1:5173/',
    'https://localhost:5173/',
    'http://localhost:5173.evil.test/',
    'http://localhost:5173@evil.test/',
    `${devUrl}/other.html`,
    `${devUrl}/?other=true`,
    'about:blank',
    '',
    'not a URL'
  ]) {
    assert.equal(isTrustedRendererUrl(actual, devUrl), false, actual)
  }
  assert.equal(isTrustedRendererUrl(devUrl, 'not a URL'), false)
  assert.equal(isTrustedRendererUrl('about:blank', 'about:blank'), false)
  assert.equal(
    isTrustedRendererUrl('file:///C:/Nexus/other.html', 'file:///C:/Nexus/index.html'),
    false
  )
})

// Execute the real main-process setup with Electron replaced, without a GUI/GPU dependency.
function harness(demo = true) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const navigation = new Map<string, (event: unknown, url: string) => void>()
  const frame = { url: `${devUrl}/` }
  const sent: string[] = []
  let invalidate: (() => void) | undefined
  let loadedUrl: string | undefined
  const sender = {
    mainFrame: frame,
    once: () => {},
    on: (name: string, callback: (event: unknown, url: string) => void) => {
      navigation.set(name, callback)
    },
    setWindowOpenHandler: () => {},
    isDestroyed: () => false,
    getURL: () => frame.url,
    send: (channel: string) => sent.push(channel)
  }
  class Window {
    webContents = sender
    once() {}
    isDestroyed() {
      return false
    }
    loadURL(url: string) {
      loadedUrl = url
    }
    static fromWebContents(candidate: unknown) {
      return candidate === sender ? window : null
    }
    static getAllWindows() {
      return [window]
    }
  }
  const window = new Window()
  const electronSession = {
    setPermissionRequestHandler: () => {},
    webRequest: { onHeadersReceived: () => {} }
  }
  const modules: Record<string, unknown> = {
    electron: {
      app: {
        isPackaged: false,
        whenReady: () => ({ then: (callback: () => void) => callback() }),
        getPath: () => '/test-user-data',
        on: () => {}
      },
      BrowserWindow: Window,
      ipcMain: {
        handle: (name: string, callback: (event: unknown, ...args: unknown[]) => unknown) =>
          handlers.set(name, callback)
      },
      session: { defaultSession: electronSession },
      shell: { openExternal: () => {} }
    },
    '../shared/api.ts': { API_METHODS: [] },
    './handlers.ts': { createSession: () => ({}), handleCall: () => 'business-result' },
    './store.ts': {
      JsonStore: class {
        load() {
          return { db: {}, currentUserId: 'demo-user' }
        }
      }
    },
    './identity.ts': {
      IdentityBridge: class {
        identity() {
          return 'identity-result'
        }
        business() {
          return 'business-result'
        }
      }
    },
    './live.ts': {
      LiveSync: class {
        constructor(_identity: unknown, callback: () => void) {
          invalidate = callback
        }
      }
    },
    './rendererSecurity.ts': { isTrustedRendererUrl }
  }
  const filename = new URL('../src/main/index.ts', import.meta.url)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  const nodeRequire = createRequire(import.meta.url)
  runInNewContext(code, {
    exports: {},
    require: (id: string) => {
      if (id.startsWith('node:')) return nodeRequire(id)
      assert.ok(id in modules, `Unexpected dependency: ${id}`)
      return modules[id]
    },
    __dirname: '/test-app/out/main',
    process: { env: { ELECTRON_RENDERER_URL: devUrl, NEXUS_MODE: demo ? 'demo' : '' } }
  })
  return { handlers, navigation, frame, sender, sent, loadedUrl, invalidate }
}

test('real IPC handlers accept the app main frame after dev URL normalization', () => {
  const app = harness()
  const event = { sender: app.sender, senderFrame: app.frame }
  assert.equal(app.loadedUrl, devUrl)
  assert.equal(app.handlers.get('nexus:mode')!(event), 'demo')
  assert.equal(app.handlers.get('nexus:identity')!(event, 'status'), 'identity-result')
  assert.equal(app.handlers.get('nexus:call')!(event, 'getState', []), 'business-result')
})

test('all real IPC handlers still reject foreign windows, subframes and foreign documents', () => {
  const app = harness()
  const invalidEvents = [
    { sender: {}, senderFrame: app.frame },
    { sender: app.sender, senderFrame: null },
    { sender: app.sender, senderFrame: { url: `${devUrl}/` } }
  ]
  for (const handler of app.handlers.values()) {
    for (const event of invalidEvents) {
      assert.throws(() => handler(event), /Untrusted IPC sender/)
    }
    for (const url of [`${devUrl}/other.html`, 'https://evil.test/', `${devUrl}/?other=true`]) {
      app.frame.url = url
      assert.throws(
        () => handler({ sender: app.sender, senderFrame: app.frame }),
        /Untrusted IPC sender/
      )
    }
    app.frame.url = `${devUrl}/`
  }
})

test('real navigation guard accepts the canonical app URL and rejects other documents', () => {
  const app = harness()
  let prevented = false
  const event = { preventDefault: () => (prevented = true) }
  const navigate = app.navigation.get('will-navigate')!
  navigate(event, `${devUrl}/#contracts`)
  assert.equal(prevented, false)
  navigate(event, `${devUrl}/other.html`)
  assert.equal(prevented, true)
})

test('real live notifications reach the canonical app URL but not foreign documents', () => {
  const app = harness(false)
  assert.ok(app.invalidate)
  app.invalidate()
  assert.deepEqual(app.sent, ['nexus:invalidate'])
  app.frame.url = `${devUrl}/other.html`
  app.invalidate()
  assert.deepEqual(app.sent, ['nexus:invalidate'])
})
