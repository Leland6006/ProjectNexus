import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { readConfig, type ServerConfig } from './config.ts'
import { IdentityService } from './auth.ts'
import { migrate } from './migrations.ts'
import { HttpError, tenancyRequest } from './tenancy.ts'
import { businessRequest, tenantChangeFingerprint } from './business.ts'
import { LiveEvents, databaseLiveInspector, tenantDirectoryFingerprint } from './live.ts'

const MAX_BODY = 512 * 1024
async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大')
    chunks.push(bytes)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new HttpError(400, 'INVALID_JSON', '请求格式无效') }
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

// Bounded in-process protection for one API instance. Configure a shared edge limiter before multi-instance deployment.
const limits = new Map<string, { count: number; reset: number }>()
function throttle(req: IncomingMessage, auth: boolean): void {
  const now = Date.now()
  const key = `${req.socket.remoteAddress}:${auth ? 'auth' : 'api'}`
  if (limits.size > 10000) for (const [k, value] of limits) if (value.reset < now) limits.delete(k)
  const entry = limits.get(key)
  if (!entry || entry.reset < now) { limits.set(key, { count: 1, reset: now + 60_000 }); return }
  if (++entry.count > (auth ? 90 : 300)) throw new HttpError(429, 'RATE_LIMITED', '操作频繁，请稍后再试')
}

export async function createApi(settings: ServerConfig) {
  const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 10, connectionTimeoutMillis: 5000,
    statement_timeout: 20000, idle_in_transaction_session_timeout: 30000 })
  try {
    await migrate(pool)
  } catch (error) { await pool.end(); throw error }
  let auth: IdentityService
  try { auth = await IdentityService.connect(settings) }
  catch (error) { await pool.end(); throw error }
  pool.on('error', () => console.error('[api] idle database connection failed'))
  const live = new LiveEvents(databaseLiveInspector(pool, (client, authorization) => auth.authenticate(client, authorization),
    async (client, principal, role) => {
      const business = await tenantChangeFingerprint(client, principal, role)
      const directory = await tenantDirectoryFingerprint(client, principal.actingOrgId!)
      return `${business}:${directory}`
    }))
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    let client: pg.PoolClient | undefined
    try {
      const url = new URL(req.url ?? '/', settings.publicUrl)
      const method = req.method ?? 'GET'
      // Desktop main-process API. Browsers are only allowed on the exact configured origin for OIDC callback.
      const origin = req.headers.origin
      if (origin && origin !== new URL(settings.publicUrl).origin) throw new HttpError(403, 'ORIGIN_DENIED', '请求来源无权访问')
      throttle(req, url.pathname.startsWith('/auth/'))
      if (method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true }); return }
      if (method === 'GET' && url.pathname === '/live') {
        if (url.search) throw new HttpError(400, 'INVALID_INPUT', '实时连接不接受URL参数')
        await live.serve(req, res)
        return
      }
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持')
      const body = method === 'GET' ? {} : await readBody(req)
      client = await pool.connect()
      await client.query('BEGIN')
      let data: unknown
      if (method === 'POST' && url.pathname === '/auth/begin') {
        const intent = body && typeof body === 'object' && 'intent' in body ? String(body.intent) : 'login'
        if (!['login', 'register', 'recover'].includes(intent)) throw new HttpError(400, 'INVALID_INPUT', '登录操作无效')
        data = await auth.begin(client, intent)
      } else if (method === 'POST' && url.pathname === '/auth/poll') {
        data = await auth.poll(client, body && typeof body === 'object' && 'ticket' in body ? body.ticket : null)
      } else if (method === 'GET' && url.pathname === '/auth/callback') {
        await auth.callback(client, url)
        await client.query('COMMIT')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Nexus 登录完成</title><p>登录完成，请返回 Nexus。此窗口可以关闭。</p></html>')
        return
      } else {
        const p = await auth.authenticate(client, req.headers.authorization)
        if (method === 'GET' && url.pathname === '/sessions') data = await auth.sessions(client, p)
        else if (method === 'POST' && url.pathname === '/logout') { await auth.revoke(client, p, p.sessionId); data = {} }
        else if (method === 'POST' && url.pathname === '/sessions/revoke-all') { await auth.revoke(client, p); data = {} }
        else if (method === 'DELETE' && /^\/sessions\/[^/]+$/.test(url.pathname)) {
          await auth.revoke(client, p, decodeURIComponent(url.pathname.split('/')[2])); data = {}
        } else if (method === 'GET' && url.pathname === '/account-security') data = { url: auth.accountUrl() }
        else if (method === 'POST' && url.pathname === '/business') {
          if (!body || typeof body !== 'object' || !('method' in body) || !('args' in body) ||
            typeof body.method !== 'string' || !Array.isArray(body.args)) throw new HttpError(400, 'INVALID_INPUT', '业务参数无效')
          data = await businessRequest(client, p, { method: body.method, args: body.args })
        } else data = await tenancyRequest(client, p, method, url.pathname, body)
      }
      await client.query('COMMIT')
      json(res, 200, { ok: true, data })
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof HttpError) json(res, error.status, { ok: false, code: error.code, message: error.message })
      else {
        // Do not log raw provider/SQL errors: they can contain tokens, identifiers or submitted personal data.
        console.error('[api] request failed', error instanceof Error ? error.name : 'UnknownError')
        json(res, 503, { ok: false, code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' })
      }
    } finally { client?.release() }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.once('close', () => live.close())
  return { server, pool, closeLive: () => live.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = readConfig()
  const { server, pool, closeLive } = await createApi(settings)
  server.listen(settings.port, settings.host, () => console.info(`[api] listening on ${settings.host}:${settings.port}`))
  const stop = () => { closeLive(); server.close(() => { void pool.end() }) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
