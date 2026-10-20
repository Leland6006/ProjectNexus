import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  LiveEvents,
  databaseLiveInspector,
  tenantDirectoryFingerprint,
  type LiveSnapshot
} from '../server/live.ts'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { PARTNER_SCHEMA } from '../server/partnerSchema.ts'
import type { Pool, PoolClient } from 'pg'
import { LiveSync, readInvalidations, type LiveSource } from '../src/main/live.ts'
import { HttpError } from '../server/tenancy.ts'
import { IdentityBridge } from '../src/main/identity.ts'

const snapshot = (): LiveSnapshot => ({
  userId: 'user',
  sessionId: 'session',
  orgId: 'org',
  role: 'business',
  fingerprint: 'first'
})
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('main静默超时取消reader并重连，停止后释放静默流', { timeout: 5000 }, async () => {
  let opens = 0
  let cancellations = 0
  const second = deferred()
  const cancelled = deferred()
  const source: LiveSource = {
    onLiveContextChange: () => () => {},
    async openLive() {
      opens++
      if (opens === 2) second.resolve()
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancellations++
            cancelled.resolve()
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
  }
  const sync = new LiveSync(source, () => {}, 5, 15)
  sync.start()
  await second.promise
  await cancelled.promise
  sync.stop()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(opens, 2)
  assert.equal(cancellations, 2)
})

test(
  'IdentityBridge只在main内授权固定流并在身份切换前停止旧上下文',
  { timeout: 5000 },
  async (t) => {
    const token = 'A'.repeat(43)
    let company = 'org-a'
    let notifications = 0
    const requests: { url: string; headers: Headers; signal?: AbortSignal | null }[] = []
    const reply = (data: unknown) =>
      new Response(JSON.stringify({ ok: true, data }), {
        headers: { 'Content-Type': 'application/json' }
      })
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, options?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/auth/begin'))
          return reply({ authorizationUrl: 'https://id.example.test/auth', ticket: 'ticket' })
        if (url.endsWith('/auth/poll')) return reply({ token })
        if (url.endsWith('/me'))
          return reply({
            account: { id: 'user' },
            companies: [{ id: company, role: 'business' }],
            actingOrgId: company
          })
        if (url.endsWith('/acting-company')) {
          company = 'org-b'
          return reply({ actingOrgId: company })
        }
        if (url.endsWith('/logout')) return reply({})
        requests.push({ url, headers: new Headers(options?.headers), signal: options?.signal })
        return new Response(': connected\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
    )
    const bridge = new IdentityBridge('https://api.example.test', false, async () => {})
    bridge.onLiveContextChange(() => {
      notifications++
    })
    assert.equal(await bridge.openLive(new AbortController().signal), null)
    assert.equal((await bridge.identity('login')).ok, true)
    await bridge.identity('status')
    const signal = new AbortController().signal
    const response = await bridge.openLive(signal)
    assert.ok(response)
    await response.body?.cancel()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.example.test/live')
    assert.equal(requests[0].headers.get('authorization'), `Bearer ${token}`)
    assert.equal(requests[0].signal, signal)
    const before = notifications
    await bridge.identity('select-company', { orgId: 'org-b' })
    assert.ok(notifications > before)
    assert.equal(await bridge.openLive(new AbortController().signal), null)
    await bridge.identity('status')
    await bridge.identity('logout')
    assert.equal(await bridge.openLive(new AbortController().signal), null)
  }
)

for (const change of ['fingerprint', 'orgId', 'role', 'revoke'] as const) {
  test(`真实HTTP失效流：${change}变化触发刷新，权限变化关闭旧流`, { timeout: 5000 }, async (t) => {
    let current = snapshot()
    let revoked = false
    const live = new LiveEvents(async (authorization) => {
      assert.equal(authorization, 'Bearer main-only')
      if (revoked) throw new HttpError(401, 'SESSION_EXPIRED', '会话已撤销')
      return { ...current }
    }, 10)
    const server = createServer((req, res) => {
      void live.serve(req, res).catch(() => {
        res.writeHead(401)
        res.end()
      })
    })
    const endpoint = await listen(server)
    const controller = new AbortController()
    t.after(() => {
      controller.abort()
      live.close()
      server.closeAllConnections()
      server.close()
    })
    const response = await fetch(endpoint, {
      headers: { Authorization: 'Bearer main-only' },
      signal: controller.signal
    })
    const changed = deferred()
    let notifications = 0
    const consuming = readInvalidations(response, controller.signal, () => {
      notifications++
      changed.resolve()
    }).catch((error) => {
      if (!controller.signal.aborted) throw error
    })
    if (change === 'revoke') revoked = true
    else current = { ...current, [change]: 'changed' }
    await changed.promise
    assert.equal(notifications, 1)
    if (change === 'fingerprint') controller.abort()
    await consuming
  })
}

test('真实SQL目录摘要覆盖收方申请/接受/消息且隔离其他租户事件', { timeout: 30_000 }, async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'))
  await db.exec(PARTNER_SCHEMA)
  await db.exec(`INSERT INTO identities(id,oidc_sub,email,name) VALUES('u','sub','u@example.test','成员');
    INSERT INTO organizations(id,name,short_name) VALUES('a','甲','甲'),('b','乙','乙'),('c','丙','丙');
    INSERT INTO memberships(id,user_id,org_id,role) VALUES('m','u','b','business');`)
  const client = {
    query: (sql: string, values: unknown[]) => db.query(sql, values)
  } as unknown as PoolClient
  const fingerprint = () => tenantDirectoryFingerprint(client, 'b')
  const empty = await fingerprint()
  await db.exec(
    `INSERT INTO audit(id,org_id,actor_id,action) VALUES('outside','c','u','business.private'),('same-org','b','u','business.private');`
  )
  assert.equal(await fingerprint(), empty, '不可见审计事件不能导致失效通知')
  await db.exec(
    `INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id) VALUES('r','a','b');`
  )
  const incoming = await fingerprint()
  assert.notEqual(incoming, empty)
  await db.exec(
    `UPDATE partner_relationships SET status='accepted',revision=revision+1 WHERE id='r';`
  )
  const accepted = await fingerprint()
  assert.notEqual(accepted, incoming)
  await db.exec(
    `INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('msg','r','u','a','机密正文不应进入摘要');`
  )
  const message = await fingerprint()
  assert.notEqual(message, accepted)
  assert.equal(message.includes('机密正文'), false)
  await db.exec(`INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id,status) VALUES('other','a','c','accepted');
    INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('other-msg','other','u','a','无关正文');`)
  assert.equal(await fingerprint(), message)
})

test('DB检查器每tick短事务提交或回滚后释放连接', async () => {
  const queries: string[] = []
  let released = 0
  let reject = false
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql.includes('SELECT m.*')) return { rows: [{ org_id: 'org', role: 'business' }] }
      return { rows: [] }
    },
    release() {
      released++
    }
  } as unknown as PoolClient
  const pool = { connect: async () => client } as unknown as Pool
  const inspector = databaseLiveInspector(
    pool,
    async () => {
      if (reject) throw new HttpError(401, 'SESSION_EXPIRED', '会话已撤销')
      return {
        userId: 'user',
        sessionId: 'session',
        actingOrgId: 'org',
        email: 'test@example.test',
        name: '成员'
      }
    },
    async () => 'fingerprint'
  )
  assert.equal((await inspector('Bearer main-only')).orgId, 'org')
  assert.equal(released, 1)
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ')
  assert.ok(queries.includes("SET LOCAL statement_timeout = '5s'"))
  assert.ok(queries.includes("SET LOCAL lock_timeout = '3s'"))
  assert.equal(queries.at(-1), 'COMMIT')
  reject = true
  await assert.rejects(inspector('Bearer main-only'))
  assert.equal(released, 2)
  assert.equal(queries.at(-1), 'ROLLBACK')
})

test('初始鉴权失败仍返回JSON且未写SSE头', { timeout: 5000 }, async (t) => {
  const live = new LiveEvents(async () => {
    throw new HttpError(401, 'UNAUTHENTICATED', '请先登录')
  })
  const server = createServer((req, res) => {
    void live.serve(req, res).catch(() => {
      assert.equal(res.headersSent, false)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"ok":false}')
    })
  })
  const endpoint = await listen(server)
  t.after(() => {
    live.close()
    server.closeAllConnections()
    server.close()
  })
  const response = await fetch(endpoint)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { ok: false })
})

test('SSE解析跨chunk帧且不转发正文或未知事件', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of [
        ': heartbeat\r\n\r\n',
        'event: invali',
        'date\r\ndata: {"secret":"hidden"}\r\n\r\n',
        'event: other\ndata: {}\n\n'
      ])
        controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
  let calls = 0
  await readInvalidations(
    new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    new AbortController().signal,
    (...args) => {
      assert.equal(args.length, 0)
      calls++
    }
  )
  assert.equal(calls, 1)
})

test('SSE解析拒绝超大帧和非事件响应', async () => {
  for (const response of [
    new Response('x'.repeat(20_000), { headers: { 'Content-Type': 'text/event-stream' } }),
    new Response('{}')
  ]) {
    await assert.rejects(
      readInvalidations(response, new AbortController().signal, () => assert.fail('不应通知'))
    )
  }
})

test('main重连补刷新、切换取消迟到连接、停止移除监听并取消重试', { timeout: 5000 }, async () => {
  let listener: (() => void) | undefined
  let removed = 0
  let opens = 0
  let invalidations = 0
  const first = deferred<Response | null>()
  const reconnected = deferred()
  const signals: AbortSignal[] = []
  const source: LiveSource = {
    onLiveContextChange(callback) {
      listener = callback
      return () => {
        removed++
        listener = undefined
      }
    },
    async openLive(signal) {
      signals.push(signal)
      opens++
      if (opens === 1) return first.promise
      if (opens === 2) throw new Error('断流')
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => controller.close(), { once: true })
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
  }
  const sync = new LiveSync(
    source,
    () => {
      invalidations++
      reconnected.resolve()
    },
    5
  )
  sync.start()
  sync.start()
  assert.equal(opens, 1)
  listener!()
  assert.equal(signals[0].aborted, true)
  first.resolve(
    new Response('event: invalidate\ndata: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' }
    })
  )
  await reconnected.promise
  assert.equal(opens, 3)
  assert.equal(invalidations, 1)
  sync.stop()
  assert.equal(signals[2].aborted, true)
  assert.equal(removed, 1)
  assert.equal(listener, undefined)
})

test('静默流在超时后主动取消并退避重连', { timeout: 5000 }, async () => {
  const reconnected = deferred()
  let opens = 0
  let cancelled = 0
  const source: LiveSource = {
    onLiveContextChange: () => () => {},
    async openLive() {
      if (++opens === 2) {
        reconnected.resolve()
        return null
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
  }
  const sync = new LiveSync(source, () => {}, 5, 15)
  sync.start()
  await reconnected.promise
  sync.stop()
  assert.equal(cancelled, 1)
  assert.equal(opens, 2)
})

test('鉴权失败在SSE header前返回JSON，同账号连接数有界', { timeout: 5000 }, async (t) => {
  const live = new LiveEvents(async (authorization) => {
    if (!authorization) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录')
    return { ...snapshot(), sessionId: authorization }
  }, 1000)
  const server = createServer((req, res) => {
    void live.serve(req, res).catch((error: HttpError) => {
      res.writeHead(error.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: error.code }))
    })
  })
  const endpoint = await listen(server)
  t.after(() => {
    live.close()
    server.closeAllConnections()
    server.close()
  })
  const unauthorized = await fetch(endpoint)
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.headers.get('content-type'), 'application/json')
  await unauthorized.body?.cancel()
  for (let index = 0; index < 4; index++) {
    const response = await fetch(endpoint, { headers: { Authorization: `session-${index}` } })
    assert.equal(response.status, 200)
  }
  const limited = await fetch(endpoint, { headers: { Authorization: 'session-5' } })
  assert.equal(limited.status, 429)
  await limited.body?.cancel()
})

test(
  '每个账号最多四个不同session实时连接且第五条保持普通错误响应',
  { timeout: 5000 },
  async (t) => {
    const live = new LiveEvents(
      async (authorization) => ({ ...snapshot(), sessionId: authorization! }),
      1000
    )
    const server = createServer((req, res) => {
      void live.serve(req, res).catch((error: HttpError) => {
        res.writeHead(error.status)
        res.end()
      })
    })
    const endpoint = await listen(server)
    const connections: Response[] = []
    t.after(async () => {
      live.close()
      for (const response of connections) await response.body?.cancel()
      server.closeAllConnections()
      server.close()
    })
    for (let index = 0; index < 4; index++)
      connections.push(await fetch(endpoint, { headers: { Authorization: `session-${index}` } }))
    const rejected = await fetch(endpoint, { headers: { Authorization: 'session-5' } })
    assert.equal(rejected.status, 429)
    assert.equal(rejected.headers.get('content-type'), null)
    await rejected.body?.cancel()
  }
)

test('服务端同session新连接替换旧连接，关闭服务结束全部流', { timeout: 5000 }, async (t) => {
  const live = new LiveEvents(async () => snapshot(), 1000)
  const server = createServer((req, res) => {
    void live.serve(req, res)
  })
  const endpoint = await listen(server)
  t.after(() => {
    live.close()
    server.closeAllConnections()
    server.close()
  })
  const first = await fetch(endpoint)
  const firstRead = first.text()
  const second = await fetch(endpoint)
  assert.equal(await firstRead, ': connected\n\n')
  const secondRead = second.text()
  live.close()
  assert.equal(await secondRead, ': connected\n\n')
})
