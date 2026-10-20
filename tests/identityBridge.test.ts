import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdentityBridge, apiEndpoint } from '../src/main/identity.ts'

const tokenA = 'A'.repeat(43)
const tokenB = 'B'.repeat(43)
const account = { account: { id: 'u', email: 'u@example.test', name: '测试' }, companies: [], actingOrgId: null }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('identity bridge rejects unsafe API URLs and reports invalid config without crashing startup', async () => {
  for (const url of ['http://example.test', 'https://u:p@example.test', 'https://example.test/api', 'https://example.test/?token=x']) {
    assert.throws(() => apiEndpoint(url, false))
    const bridge = new IdentityBridge(url, false, async () => {})
    const result = await bridge.identity('status')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_CONFIG')
  }
  assert.equal(apiEndpoint('http://127.0.0.1:4318', true), 'http://127.0.0.1:4318')
})

test('identity bridge rejects insecure provider URLs in production before opening a browser', async (t) => {
  let opened = 0
  t.mock.method(globalThis, 'fetch', async () => reply({ ok: true, data: { authorizationUrl: 'http://example.test/auth', ticket: 'secret' } }))
  const bridge = new IdentityBridge('https://api.example.test', false, async () => { opened++ })
  const result = await bridge.identity('login')
  assert.equal(result.ok, false)
  assert.equal(opened, 0)
})

test('identity bridge: stale 401 from a previous session cannot clear a newly signed-in session', async (t) => {
  let loginCount = 0
  let release!: (response: Response) => void
  const previousRequest = new Promise<Response>((resolve) => { release = resolve })
  let authorized: string | null = null
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/auth/begin') return reply({ ok: true, data: { authorizationUrl: 'https://id.example.test/auth', ticket: 'login-ticket' } })
    if (path === '/auth/poll') return reply({ ok: true, data: { token: ++loginCount === 1 ? tokenA : tokenB } })
    if (path === '/business') return previousRequest
    if (path === '/logout') return reply({ ok: true, data: {} })
    if (path === '/me') {
      authorized = (options?.headers as Record<string, string>).Authorization ?? null
      return reply({ ok: true, data: account })
    }
    throw new Error(`Unexpected path ${path}`)
  })
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {})
  assert.equal((await bridge.identity('login')).ok, true)
  const stale = bridge.business('getState', [])
  assert.equal((await bridge.identity('logout')).ok, true)
  assert.equal((await bridge.identity('login')).ok, true)
  release(reply({ ok: false, code: 'SESSION_EXPIRED', message: '旧会话已撤销' }, 401))
  await stale
  const result = await bridge.identity('status')
  assert.equal(result.ok, true)
  assert.equal(authorized, `Bearer ${tokenB}`)
  if (result.ok) assert.deepEqual((result.data as typeof account).account, account.account)
})

test('identity bridge catches account-page URL and browser-launch failures', async (t) => {
  let page = 'https://u:p@example.test/account'
  t.mock.method(globalThis, 'fetch', async () => reply({ ok: true, data: { url: page } }))
  const bridge = new IdentityBridge('https://api.example.test', false, async () => { throw new Error('browser unavailable') })
  assert.equal((await bridge.identity('account-security')).ok, false)
  page = 'https://id.example.test/account'
  assert.equal((await bridge.identity('account-security')).ok, false)
})
