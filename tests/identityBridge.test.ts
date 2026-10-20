import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdentityBridge, apiEndpoint } from '../src/main/identity.ts'

const tokenA = 'A'.repeat(43)
const tokenB = 'B'.repeat(43)
const account = {
  account: { id: 'u', email: 'u@example.test', name: '测试' },
  companies: [],
  actingOrgId: null
}
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('identity bridge rejects unsafe API URLs and reports invalid config without crashing startup', async () => {
  for (const url of [
    'http://example.test',
    'https://u:p@example.test',
    'https://example.test/api',
    'https://example.test/?token=x'
  ]) {
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
  t.mock.method(globalThis, 'fetch', async () =>
    reply({ ok: true, data: { authorizationUrl: 'http://example.test/auth', ticket: 'secret' } })
  )
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {
    opened++
  })
  const result = await bridge.identity('login')
  assert.equal(result.ok, false)
  assert.equal(opened, 0)
})

test('identity bridge: stale 401 from a previous session cannot clear a newly signed-in session', async (t) => {
  let loginCount = 0
  let release!: (response: Response) => void
  const previousRequest = new Promise<Response>((resolve) => {
    release = resolve
  })
  let authorized: string | null = null
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/auth/begin')
        return reply({
          ok: true,
          data: { authorizationUrl: 'https://id.example.test/auth', ticket: 'login-ticket' }
        })
      if (path === '/auth/poll')
        return reply({ ok: true, data: { token: ++loginCount === 1 ? tokenA : tokenB } })
      if (path === '/business') return previousRequest
      if (path === '/logout') return reply({ ok: true, data: {} })
      if (path === '/me') {
        authorized = (options?.headers as Record<string, string>).Authorization ?? null
        return reply({ ok: true, data: account })
      }
      throw new Error(`Unexpected path ${path}`)
    }
  )
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

test('identity bridge routes partner lifecycle and messages through fixed paths without accepting actor fields', async (t) => {
  const requests: { path: string; method: string; body: unknown }[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: options?.method ?? 'GET',
        body: options?.body ? JSON.parse(String(options.body)) : undefined
      })
      return reply({ ok: true, data: {} })
    }
  )
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {})
  assert.equal((await bridge.identity('partners')).ok, true)
  assert.equal(
    (await bridge.identity('create-partner', { orgId: 'target', userId: 'forged', role: 'owner' }))
      .ok,
    true
  )
  for (const action of ['accept', 'reject', 'withdraw', 'disconnect'])
    assert.equal(
      (await bridge.identity(`${action}-partner`, { id: 'relationship', actingOrgId: 'forged' }))
        .ok,
      true
    )
  assert.equal((await bridge.identity('partner-messages', { id: 'relationship' })).ok, true)
  assert.equal(
    (
      await bridge.identity('send-partner-message', {
        id: 'relationship',
        body: 'hello',
        authorId: 'forged',
        orgId: 'forged'
      })
    ).ok,
    true
  )
  assert.deepEqual(requests, [
    { path: '/partners', method: 'GET', body: undefined },
    { path: '/partners', method: 'POST', body: { orgId: 'target' } },
    ...['accept', 'reject', 'withdraw', 'disconnect'].map((action) => ({
      path: `/partners/relationship/${action}`,
      method: 'POST',
      body: {}
    })),
    { path: '/partners/relationship/messages', method: 'GET', body: undefined },
    { path: '/partners/relationship/messages', method: 'POST', body: { body: 'hello' } }
  ])
  const before = requests.length
  assert.equal((await bridge.identity('accept-partner')).ok, false)
  assert.equal((await bridge.identity('send-partner-message', {})).ok, false)
  assert.equal(requests.length, before)
})

test('实时桥接只在当前企业生效后连接，切换时丢弃迟到响应并复核401', async (t) => {
  let selected = 'a'
  let expired = false
  let release!: (response: Response) => void
  let liveCalls = 0
  let cancelled = 0
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/auth/begin')
        return reply({
          ok: true,
          data: { authorizationUrl: 'https://id.example.test/auth', ticket: 'test' }
        })
      if (url.pathname === '/auth/poll') return reply({ ok: true, data: { token: tokenA } })
      if (url.pathname === '/acting-company') {
        selected = 'b'
        return reply({ ok: true, data: {} })
      }
      if (url.pathname === '/me')
        return expired
          ? reply({ ok: false, code: 'SESSION_EXPIRED', message: '会话已失效' }, 401)
          : reply({
              ok: true,
              data: {
                ...account,
                companies: [{ id: selected, role: 'business' }],
                actingOrgId: selected
              }
            })
      if (url.pathname === '/live') {
        liveCalls++
        assert.equal(url.search, '')
        assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${tokenA}`)
        assert.equal(options?.redirect, 'error')
        return liveCalls === 1 ? pending : reply({}, 401)
      }
      throw new Error(`Unexpected path ${url.pathname}`)
    }
  )
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {})
  const controller = new AbortController()
  assert.equal(await bridge.openLive(controller.signal), null)
  assert.equal((await bridge.identity('login')).ok, true)
  await bridge.identity('status')
  let notifications = 0
  const remove = bridge.onLiveContextChange(() => {
    notifications++
  })
  const old = bridge.openLive(controller.signal)
  await bridge.identity('select-company', { orgId: 'b' })
  assert.equal(await bridge.openLive(controller.signal), null)
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  )
  assert.equal(await old, null)
  assert.equal(cancelled, 1)
  await bridge.identity('status')
  assert.equal((await bridge.openLive(controller.signal))?.status, 401)
  expired = true
  const status = await bridge.identity('status')
  assert.equal(status.ok, true)
  if (status.ok) assert.equal((status.data as { account: unknown }).account, null)
  assert.equal(await bridge.openLive(controller.signal), null)
  assert.equal(liveCalls, 2)
  assert.ok(notifications >= 3)
  remove()
  const count = notifications
  await bridge.identity('logout')
  assert.equal(notifications, count)
})

test('identity bridge catches account-page URL and browser-launch failures', async (t) => {
  let page = 'https://u:p@example.test/account'
  t.mock.method(globalThis, 'fetch', async () => reply({ ok: true, data: { url: page } }))
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {
    throw new Error('browser unavailable')
  })
  assert.equal((await bridge.identity('account-security')).ok, false)
  page = 'https://id.example.test/account'
  assert.equal((await bridge.identity('account-security')).ok, false)
})
