import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test, type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { PoolClient } from 'pg'
import { AUTH_SCHEMA, IdentityService } from '../server/auth.ts'
import { decrypt, digest, readConfig } from '../server/config.ts'
import { HttpError, tenancyRequest } from '../server/tenancy.ts'

// 本地受控 OIDC 协议提供者与 PostgreSQL WASM；不代表真实 Keycloak、SMTP 或多连接锁竞争已验证。
type GrantPlan = {
  sub?: string; email?: string; verified?: boolean; nonce?: string; audience?: string
  issuer?: string; expired?: boolean; badSignature?: boolean; noRefresh?: boolean
}
type Grant = { sub: string; nonce: string; plan: GrantPlan; challenge: string; redirectUri: string }
type Access = { sub: string; active: boolean }
type Refresh = { sub: string; active: boolean; access: string }

function adapt(database: { query: PGlite['query'] }, statements: string[]): PoolClient {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql)
      const result = await database.query(sql, values)
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 }
    }
  } as unknown as PoolClient
}

async function rejectsHttp(request: Promise<unknown>, status: number, code: string) {
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return true
  })
}

async function fixture(t: TestContext) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-rsa', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, Grant>()
  const accessTokens = new Map<string, Access>()
  const refreshTokens = new Map<string, Refresh>()
  const calls = { discovery: 0, jwks: 0, codes: [] as URLSearchParams[], refresh: [] as URLSearchParams[], introspection: [] as URLSearchParams[], revocation: [] as URLSearchParams[] }
  let nextPlan: GrantPlan = {}
  let issuer = ''
  let failRevocation = false
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  const tokens = (sub: string) => {
    const access = `fixture-access-${randomUUID()}`
    const refresh = `fixture-refresh-${randomUUID()}`
    accessTokens.set(access, { sub, active: true })
    refreshTokens.set(refresh, { sub, active: true, access })
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 300 }
  }
  const requestBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', issuer)
      const prefix = new URL(issuer).pathname
      if (url.pathname === `${prefix}/.well-known/openid-configuration`) {
        calls.discovery++
        json(res, 200, {
          issuer, authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`, jwks_uri: `${issuer}/jwks`,
          introspection_endpoint: `${issuer}/introspect`, revocation_endpoint: `${issuer}/revoke`,
          response_types_supported: ['code'], subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
          introspection_endpoint_auth_methods_supported: ['client_secret_post'],
          revocation_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256']
        })
        return
      }
      if (url.pathname === `${prefix}/jwks`) {
        calls.jwks++
        json(res, 200, { keys: [jwk] })
        return
      }
      if (url.pathname === `${prefix}/protocol/openid-connect/auth`) {
        const code = randomUUID()
        const plan = nextPlan
        nextPlan = {}
        codes.set(code, {
          sub: plan.sub ?? randomUUID(), nonce: url.searchParams.get('nonce') ?? '', plan,
          challenge: url.searchParams.get('code_challenge') ?? '', redirectUri: url.searchParams.get('redirect_uri') ?? ''
        })
        const callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { Location: callback.href })
        res.end()
        return
      }
      const body = await requestBody(req)
      if (body.get('client_id') !== 'fixture-client' || body.get('client_secret') !== 'fixture-secret') {
        json(res, 401, { error: 'invalid_client' })
        return
      }
      if (url.pathname === `${prefix}/protocol/openid-connect/token` && body.get('grant_type') === 'authorization_code') {
        calls.codes.push(body)
        const code = body.get('code') ?? ''
        const grant = codes.get(code)
        codes.delete(code)
        if (!grant || body.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) {
          json(res, 400, { error: 'invalid_grant' })
          return
        }
        const now = Math.floor(Date.now() / 1000)
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-rsa', typ: 'JWT' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({
          iss: grant.plan.issuer ?? issuer, aud: grant.plan.audience ?? 'fixture-client', sub: grant.sub,
          iat: now, exp: grant.plan.expired ? now - 600 : now + 300, auth_time: now,
          nonce: grant.plan.nonce ?? grant.nonce, email: grant.plan.email ?? 'Protocol.User@example.test',
          email_verified: grant.plan.verified ?? true, name: '协议测试用户',
          roles: ['owner'], org_id: '不可信令牌企业'
        })).toString('base64url')
        const input = `${header}.${payload}`
        const signature = sign('RSA-SHA256', Buffer.from(input), grant.plan.badSignature ? otherKey : keys.privateKey).toString('base64url')
        const result: Record<string, unknown> = { ...tokens(grant.sub), id_token: `${input}.${signature}` }
        if (grant.plan.noRefresh) delete result.refresh_token
        json(res, 200, result)
        return
      }
      if (url.pathname === `${prefix}/protocol/openid-connect/token` && body.get('grant_type') === 'refresh_token') {
        calls.refresh.push(body)
        const original = refreshTokens.get(body.get('refresh_token') ?? '')
        if (!original?.active) { json(res, 400, { error: 'invalid_grant' }); return }
        original.active = false
        json(res, 200, tokens(original.sub))
        return
      }
      if (url.pathname === `${prefix}/introspect`) {
        calls.introspection.push(body)
        const token = accessTokens.get(body.get('token') ?? '')
        json(res, 200, token?.active ? { active: true, sub: token.sub, client_id: 'fixture-client', token_type: 'Bearer' } : { active: false })
        return
      }
      if (url.pathname === `${prefix}/revoke`) {
        calls.revocation.push(body)
        if (failRevocation) { json(res, 503, { error: 'temporarily_unavailable' }); return }
        const token = refreshTokens.get(body.get('token') ?? '')
        if (token) {
          token.active = false
          const access = accessTokens.get(token.access)
          if (access) access.active = false
        }
        res.writeHead(200)
        res.end()
        return
      }
      json(res, 404, { error: 'not_found' })
    } catch {
      json(res, 500, { error: 'fixture_error' })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  issuer = `http://127.0.0.1:${address.port}/realms/protocol-tests`
  const settings = readConfig({
    NODE_ENV: 'development', DATABASE_URL: 'postgresql://unused/protocol-tests', OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'fixture-client', OIDC_CLIENT_SECRET: 'fixture-secret',
    API_PUBLIC_URL: 'http://127.0.0.1:4318', OIDC_ACCOUNT_URL: `${issuer}/account`,
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64')
  })
  const database = new PGlite()
  t.after(() => database.close())
  await database.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'))
  await database.exec(AUTH_SCHEMA)
  const statements: string[] = []
  const transaction = <T>(run: (client: PoolClient) => Promise<T>) => database.transaction((tx) => run(adapt(tx, statements)))
  const auth = await IdentityService.connect(settings)
  const begin = (intent = 'login') => transaction((client) => auth.begin(client, intent))
  const callback = (url: URL) => transaction((client) => auth.callback(client, url))
  const poll = (ticket: unknown) => transaction((client) => auth.poll(client, ticket))
  const authenticate = (token?: string) => transaction((client) => auth.authenticate(client, token === undefined ? undefined : `Bearer ${token}`))
  const authorize = async (authorizationUrl: string, plan: GrantPlan = {}) => {
    nextPlan = plan
    const response = await fetch(authorizationUrl, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.ok(response.headers.get('location'))
    return new URL(response.headers.get('location')!)
  }
  const login = async (plan: GrantPlan = {}) => {
    const started = await begin()
    const url = await authorize(started.authorizationUrl, plan)
    await callback(url)
    const result = await poll(started.ticket)
    assert.ok('token' in result)
    const principal = await authenticate(result.token)
    const session = await database.query<{ id: string; user_id: string; token_hash: string; access_cipher: string; refresh_cipher: string | null }>('SELECT * FROM sessions WHERE id=$1', [principal.sessionId])
    return { ...started, token: result.token, principal, session: session.rows[0], callbackUrl: url }
  }
  return { database, settings, calls, auth, transaction, begin, callback, poll, authenticate, authorize, login, accessTokens, refreshTokens, statements,
    setFailRevocation: (value: boolean) => { failRevocation = value } }
}

test('受控 OIDC HTTP 提供者 + 真实 openid-client + PostgreSQL 认证协议', { timeout: 90_000 }, async (t) => {
  const f = await fixture(t)

  await t.test('discovery、PKCE S256、state/nonce 与票据使用独立随机值，数据库只保留哈希和密文', async () => {
    assert.equal(f.calls.discovery, 1)
    const first = await f.begin()
    const second = await f.begin()
    const url = new URL(first.authorizationUrl)
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('client_id'), 'fixture-client')
    assert.equal(url.searchParams.get('scope'), 'openid email profile')
    assert.equal(url.searchParams.get('prompt'), 'login')
    assert.equal(url.searchParams.get('max_age'), '0')
    assert.equal(url.searchParams.get('redirect_uri'), `${f.settings.publicUrl}/auth/callback`)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    const state = url.searchParams.get('state')!
    const nonce = url.searchParams.get('nonce')!
    assert.ok(state.length >= 32 && nonce.length >= 32)
    assert.notEqual(state, nonce)
    assert.notEqual(first.ticket, state)
    assert.notEqual(first.ticket, second.ticket)
    assert.notEqual(state, new URL(second.authorizationUrl).searchParams.get('state'))
    const stored = await f.database.query<{ state_hash: string; ticket_hash: string; verifier_cipher: string; nonce: string }>('SELECT * FROM auth_transactions WHERE state_hash=$1', [digest(state)])
    const row = stored.rows[0]
    assert.equal(row.state_hash, digest(state))
    assert.equal(row.ticket_hash, digest(first.ticket))
    assert.equal(row.nonce, nonce)
    const verifier = decrypt(row.verifier_cipher, f.settings.encryptionKey)
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/)
    assert.notEqual(row.verifier_cipher, verifier)
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'))
    assert.deepEqual(await f.poll(first.ticket), { pending: true })
    await rejectsHttp(f.poll(null), 400, 'INVALID_INPUT')
    await rejectsHttp(f.poll('x'.repeat(129)), 400, 'INVALID_INPUT')
    await rejectsHttp(f.poll(randomBytes(32).toString('base64url')), 401, 'AUTH_EXPIRED')
  })

  await t.test('注册使用提供者 create prompt，找回密码使用 forgot-credentials 托管流程', async () => {
    const register = new URL((await f.begin('register')).authorizationUrl)
    assert.equal(register.searchParams.get('prompt'), 'create')
    const recover = new URL((await f.begin('recover')).authorizationUrl)
    assert.ok(recover.pathname.endsWith('/forgot-credentials'), recover.pathname)
    assert.ok(recover.searchParams.get('state'))
    assert.ok(recover.searchParams.get('code_challenge'))
  })

  await t.test('未知或缺少 state 在交换令牌前拒绝', async () => {
    const before = f.calls.codes.length
    await rejectsHttp(f.callback(new URL(`${f.settings.publicUrl}/auth/callback?code=unknown`)), 400, 'INVALID_AUTH')
    await rejectsHttp(f.callback(new URL(`${f.settings.publicUrl}/auth/callback?code=unknown&state=unknown`)), 400, 'INVALID_AUTH')
    assert.equal(f.calls.codes.length, before)
  })

  await t.test('交换两次授权的 code/state 时提供者拒绝不匹配 PKCE verifier', async () => {
    const first = await f.begin()
    const second = await f.begin()
    const url = await f.authorize(first.authorizationUrl)
    url.searchParams.set('state', new URL(second.authorizationUrl).searchParams.get('state')!)
    const before = f.calls.codes.length
    await assert.rejects(f.callback(url))
    assert.equal(f.calls.codes.length, before + 1)
    assert.deepEqual(await f.poll(first.ticket), { pending: true })
    assert.deepEqual(await f.poll(second.ticket), { pending: true })
  })

  await t.test('未验证邮箱拒绝登录并回滚身份、会话、审计和完成状态', async () => {
    const started = await f.begin()
    const url = await f.authorize(started.authorizationUrl, { verified: false })
    await rejectsHttp(f.callback(url), 403, 'EMAIL_UNVERIFIED')
    for (const table of ['identities', 'sessions', 'audit']) {
      const count = await f.database.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)
      assert.equal(count.rows[0].count, 0)
    }
    assert.deepEqual(await f.poll(started.ticket), { pending: true })
  })

  for (const [name, plan] of [
    ['nonce 不匹配', { nonce: 'untrusted-nonce' }],
    ['audience 不匹配', { audience: 'different-client' }],
    ['issuer 不匹配', { issuer: 'http://127.0.0.1/other-issuer' }],
    ['ID token 过期', { expired: true }],
    ['ID token RSA 签名不匹配', { badSignature: true }]
  ] satisfies [string, GrantPlan][]) {
    await t.test(`${name}时真实客户端拒绝 code grant，事务不落会话`, async () => {
      const started = await f.begin()
      const url = await f.authorize(started.authorizationUrl, plan)
      await assert.rejects(f.callback(url))
      const count = await f.database.query<{ count: number }>('SELECT count(*)::integer AS count FROM sessions')
      assert.equal(count.rows[0].count, 0)
      assert.deepEqual(await f.poll(started.ticket), { pending: true })
    })
  }

  await t.test('真实 code grant 获取 JWKS；state 与 poll 票据一次性；新身份企业为空且令牌不明文落库', async () => {
    const started = await f.begin()
    const callbackUrl = await f.authorize(started.authorizationUrl, { sub: 'new-protocol-user' })
    await f.callback(callbackUrl)
    assert.ok(f.calls.jwks > 0, '必须实际从提供者获取 JWKS 验证 ID token 签名')
    const beforeReplay = f.calls.codes.length
    await rejectsHttp(f.callback(callbackUrl), 400, 'INVALID_AUTH')
    assert.equal(f.calls.codes.length, beforeReplay)
    const tx = await f.database.query<{ session_cipher: string }>('SELECT session_cipher FROM auth_transactions WHERE ticket_hash=$1', [digest(started.ticket)])
    const result = await f.poll(started.ticket)
    assert.ok('token' in result)
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(tx.rows[0].session_cipher, result.token)
    assert.equal(decrypt(tx.rows[0].session_cipher, f.settings.encryptionKey), result.token)
    await rejectsHttp(f.poll(started.ticket), 401, 'AUTH_EXPIRED')
    await rejectsHttp(f.callback(callbackUrl), 400, 'INVALID_AUTH')
    const p = await f.authenticate(result.token)
    assert.equal(p.email, 'protocol.user@example.test')
    assert.equal(p.actingOrgId, null)
    const me = await f.transaction((client) => tenancyRequest(client, p, 'GET', '/me', {})) as { companies: unknown[]; actingOrgId: null }
    assert.deepEqual(me.companies, [])
    assert.equal(me.actingOrgId, null)
    const stored = await f.database.query<{ token_hash: string; access_cipher: string; refresh_cipher: string }>('SELECT * FROM sessions WHERE id=$1', [p.sessionId])
    const row = stored.rows[0]
    assert.equal(row.token_hash, digest(result.token))
    const access = decrypt(row.access_cipher, f.settings.encryptionKey)
    const refresh = decrypt(row.refresh_cipher, f.settings.encryptionKey)
    assert.ok(f.accessTokens.has(access))
    assert.ok(f.refreshTokens.has(refresh))
    const snapshot = JSON.stringify((await f.database.query('SELECT * FROM sessions')).rows)
    for (const secret of [result.token, access, refresh]) assert.equal(snapshot.includes(secret), false)
    assert.equal(f.calls.codes.at(-1)!.get('code_verifier')!.length >= 43, true)
    assert.equal(f.calls.introspection.at(-1)!.get('token'), access)
  })

  await t.test('身份非键更新锁先于会话行锁并兼容外键检查，成员移除后清理当前企业', async () => {
    const logged = await f.login()
    const orgId = randomUUID()
    await f.database.query('INSERT INTO organizations(id,name,short_name) VALUES($1,$2,$3)', [orgId, '协议测试企业', '协议'])
    await f.database.query("INSERT INTO memberships(id,user_id,org_id,role) VALUES($1,$2,$3,'owner')", [randomUUID(), logged.principal.userId, orgId])
    await f.database.query('UPDATE sessions SET acting_org_id=$1 WHERE id=$2', [orgId, logged.principal.sessionId])
    const before = f.statements.length
    assert.equal((await f.authenticate(logged.token)).actingOrgId, orgId)
    const statements = f.statements.slice(before)
    const ownerLookup = statements.findIndex((sql) => /SELECT user_id FROM sessions WHERE token_hash/.test(sql))
    const identityLock = statements.findIndex((sql) => /FROM identities WHERE id=\$1 FOR NO KEY UPDATE$/.test(sql))
    const sessionLock = statements.findIndex((sql) => /FOR UPDATE OF s/.test(sql))
    assert.ok(ownerLookup >= 0 && identityLock > ownerLookup && sessionLock > identityLock,
      '认证须先以非键更新锁串行化同用户请求，再锁会话；该身份锁与外键 KEY SHARE 锁兼容')
    assert.equal(statements.some((sql) => /FROM identities WHERE id=\$1 FOR UPDATE(?:\s|$)/.test(sql)), false,
      '身份锁不得升级为会阻塞外键检查的 FOR UPDATE')
    await f.database.query("UPDATE memberships SET status='removed' WHERE user_id=$1 AND org_id=$2", [logged.principal.userId, orgId])
    assert.equal((await f.authenticate(logged.token)).actingOrgId, null)
    const stored = await f.database.query<{ acting_org_id: null }>('SELECT acting_org_id FROM sessions WHERE id=$1', [logged.principal.sessionId])
    assert.equal(stored.rows[0].acting_org_id, null)
  })

  await t.test('有效会话每次 introspection；停用身份及本地撤销或过期在联网前拒绝', async () => {
    const logged = await f.login()
    const before = f.calls.introspection.length
    const p = await f.authenticate(logged.token)
    assert.equal(p.userId, logged.principal.userId)
    assert.equal(f.calls.introspection.length, before + 1)
    await rejectsHttp(f.authenticate(), 401, 'UNAUTHENTICATED')
    await rejectsHttp(f.authenticate('malformed'), 401, 'UNAUTHENTICATED')
    for (const change of [
      "UPDATE identities SET status='disabled' WHERE id=$1",
      'UPDATE sessions SET revoked_at=now() WHERE user_id=$1',
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1"
    ]) {
      await f.database.query(change, [p.userId])
      const requests = f.calls.introspection.length
      await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
      assert.equal(f.calls.introspection.length, requests)
      await f.database.query("UPDATE identities SET status='active' WHERE id=$1", [p.userId])
      await f.database.query("UPDATE sessions SET revoked_at=NULL,expires_at=now()+interval '1 hour' WHERE user_id=$1", [p.userId])
    }
  })

  await t.test('access 失效会刷新并轮换密文，再次 introspection；refresh 撤销后拒绝', async () => {
    const logged = await f.login()
    const originalAccess = decrypt(logged.session.access_cipher, f.settings.encryptionKey)
    const originalRefresh = decrypt(logged.session.refresh_cipher!, f.settings.encryptionKey)
    f.accessTokens.get(originalAccess)!.active = false
    const before = f.calls.introspection.length
    const refreshed = await f.authenticate(logged.token)
    assert.equal(refreshed.userId, logged.principal.userId)
    assert.equal(f.calls.refresh.at(-1)!.get('refresh_token'), originalRefresh)
    assert.equal(f.calls.introspection.length, before + 2)
    const stored = await f.database.query<{ access_cipher: string; refresh_cipher: string }>('SELECT access_cipher,refresh_cipher FROM sessions WHERE id=$1', [refreshed.sessionId])
    const access = decrypt(stored.rows[0].access_cipher, f.settings.encryptionKey)
    const refresh = decrypt(stored.rows[0].refresh_cipher, f.settings.encryptionKey)
    assert.notEqual(access, originalAccess)
    assert.notEqual(refresh, originalRefresh)
    assert.equal(f.calls.introspection.at(-1)!.get('token'), access)
    f.accessTokens.get(access)!.active = false
    f.refreshTokens.get(refresh)!.active = false
    await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
  })

  await t.test('无 refresh 的失效 access 及 introspection 主体错配均拒绝', async () => {
    const logged = await f.login({ noRefresh: true })
    const access = decrypt(logged.session.access_cipher, f.settings.encryptionKey)
    f.accessTokens.get(access)!.sub = 'different-subject'
    await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
    f.accessTokens.get(access)!.active = false
    const before = f.calls.refresh.length
    await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
    assert.equal(f.calls.refresh.length, before)
  })

  await t.test('撤销提供者 refresh 后本地会话不可再用，其他会话保持有效', async () => {
    const sub = randomUUID()
    const logged = await f.login({ sub })
    const other = await f.login({ sub })
    const refresh = decrypt(logged.session.refresh_cipher!, f.settings.encryptionKey)
    await f.transaction((client) => f.auth.revoke(client, logged.principal, logged.principal.sessionId))
    assert.equal(f.calls.revocation.at(-1)!.get('token'), refresh)
    assert.equal(f.calls.revocation.at(-1)!.get('token_type_hint'), 'refresh_token')
    assert.equal(f.refreshTokens.get(refresh)!.active, false)
    await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
    assert.equal((await f.authenticate(other.token)).sessionId, other.principal.sessionId)
    const audit = await f.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM audit WHERE action='session.revoked' AND target_id=$1", [logged.principal.sessionId])
    assert.equal(audit.rows[0].count, 1)
  })

  await t.test('提供者 revocation 失败回滚本地撤销，成功重试可撤销该身份全部会话', async () => {
    const sub = randomUUID()
    const logged = await f.login({ sub })
    const other = await f.login({ sub })
    f.setFailRevocation(true)
    try {
      await assert.rejects(f.transaction((client) => f.auth.revoke(client, logged.principal, logged.principal.sessionId)))
    } finally { f.setFailRevocation(false) }
    const stored = await f.database.query<{ revoked_at: null }>('SELECT revoked_at FROM sessions WHERE id=$1', [logged.principal.sessionId])
    assert.equal(stored.rows[0].revoked_at, null)
    assert.equal((await f.authenticate(logged.token)).sessionId, logged.principal.sessionId)
    await f.transaction((client) => f.auth.revoke(client, logged.principal))
    await rejectsHttp(f.authenticate(logged.token), 401, 'SESSION_EXPIRED')
    await rejectsHttp(f.authenticate(other.token), 401, 'SESSION_EXPIRED')
  })

  await t.test('auth transaction 过期拒绝 callback/poll，begin 清理过期票据', async () => {
    const started = await f.begin()
    const url = await f.authorize(started.authorizationUrl)
    await f.database.query("UPDATE auth_transactions SET expires_at=now()-interval '1 second' WHERE ticket_hash=$1", [digest(started.ticket)])
    const before = f.calls.codes.length
    await rejectsHttp(f.callback(url), 400, 'INVALID_AUTH')
    await rejectsHttp(f.poll(started.ticket), 401, 'AUTH_EXPIRED')
    assert.equal(f.calls.codes.length, before)
    await f.begin()
    assert.deepEqual((await f.database.query('SELECT * FROM auth_transactions WHERE ticket_hash=$1', [digest(started.ticket)])).rows, [])
  })
})
