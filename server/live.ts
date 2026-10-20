import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { HttpError, requireMembership, type MembershipRole, type Principal } from './tenancy.ts'

export type LiveSnapshot = { userId: string; sessionId: string; orgId: string; role: string; fingerprint: string }
export type LiveInspect = (authorization: string | undefined) => Promise<LiveSnapshot>
type LiveConnection = { snapshot: LiveSnapshot; close: (invalidate?: boolean) => void }

/** 服务端推送由租户范围DB轮询驱动，不使用全平台revision或LISTEN。 */
export function databaseLiveInspector(pool: Pool, authenticate: (client: PoolClient, authorization: string | undefined) => Promise<Principal>,
  fingerprint: (client: PoolClient, principal: Principal, role: MembershipRole) => Promise<string>): LiveInspect {
  return async (authorization) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query("SET LOCAL lock_timeout = '3s'")
      const principal = await authenticate(client, authorization)
      const membership = await requireMembership(client, principal)
      const value = await fingerprint(client, principal, membership.role)
      await client.query('COMMIT')
      return { userId: principal.userId, sessionId: principal.sessionId, orgId: membership.org_id, role: membership.role, fingerprint: value }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}

export async function tenantDirectoryFingerprint(client: PoolClient, orgId: string): Promise<string> {
  const result = await client.query(`SELECT
    (SELECT md5(COALESCE(string_agg(id || ':' || revision::text, ',' ORDER BY id),''))
      FROM partner_relationships WHERE requester_org_id=$1 OR recipient_org_id=$1) AS partners,
    (SELECT count(*)::text FROM partner_messages m JOIN partner_relationships r ON r.id=m.relationship_id
      WHERE (r.requester_org_id=$1 OR r.recipient_org_id=$1) AND r.status IN ('accepted','disconnected')) AS messages,
    (SELECT md5(COALESCE(string_agg(m.id || ':' || m.role || ':' || m.status || ':' || i.name, ',' ORDER BY m.id),''))
      FROM memberships m JOIN identities i ON i.id=m.user_id WHERE m.org_id=$1) AS members`, [orgId])
  return JSON.stringify(result.rows[0])
}

export class LiveEvents {
  private readonly inspect: LiveInspect
  private readonly interval: number
  private readonly connections = new Set<LiveConnection>()
  private opening = 0
  private stopped = false
  constructor(inspect: LiveInspect, interval = 1500) { this.inspect = inspect; this.interval = interval }
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopped || this.connections.size + this.opening >= 128) throw new HttpError(503, 'LIVE_LIMIT', '实时连接暂时不可用')
    this.opening++
    let snapshot: LiveSnapshot
    try { snapshot = await this.inspect(req.headers.authorization) }
    finally { this.opening-- }
    if (this.stopped || res.destroyed) { res.end(); return }
    const current = [...this.connections].filter((entry) => entry.snapshot.userId === snapshot.userId)
    if (current.filter((entry) => entry.snapshot.sessionId !== snapshot.sessionId).length >= 4) {
      throw new HttpError(429, 'LIVE_LIMIT', '实时连接数量已达上限')
    }
    // 同一服务实例中同一session最多一条流；新连接取代旧连接。
    for (const connection of current) if (connection.snapshot.sessionId === snapshot.sessionId) connection.close()
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
    res.flushHeaders()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lifetime: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const write = (value: string) => {
      if (!closed && !res.destroyed && !res.write(value)) connection.close()
    }
    const connection: LiveConnection = { snapshot, close: (invalidate = false) => {
      if (closed) return
      if (invalidate && !res.destroyed) res.write('event: invalidate\ndata: {}\n\n')
      closed = true
      if (timer) clearTimeout(timer)
      if (lifetime) clearTimeout(lifetime)
      this.connections.delete(connection)
      res.off('close', onClose)
      res.end()
    } }
    const onClose = () => connection.close()
    this.connections.add(connection)
    res.once('close', onClose)
    lifetime = setTimeout(() => connection.close(), 10 * 60_000)
    write(': connected\n\n')
    const poll = async () => {
      try {
        const next = await this.inspect(req.headers.authorization)
        if (closed) return
        if (next.userId !== snapshot.userId || next.sessionId !== snapshot.sessionId || next.orgId !== snapshot.orgId || next.role !== snapshot.role) {
          connection.close(true)
          return
        }
        if (next.fingerprint !== snapshot.fingerprint) {
          snapshot = next
          connection.snapshot = next
          write('event: invalidate\ndata: {}\n\n')
        } else write(': heartbeat\n\n')
      } catch { connection.close(true) }
      if (!closed) timer = setTimeout(() => void poll(), this.interval)
    }
    if (!closed) timer = setTimeout(() => void poll(), this.interval)
  }
  close(): void {
    this.stopped = true
    for (const connection of this.connections) connection.close()
  }
}
