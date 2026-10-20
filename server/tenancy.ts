import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export type MembershipRole = 'owner' | 'admin' | 'business' | 'finance' | 'legal' | 'readonly'
export type Principal = { userId: string; email: string; name: string; sessionId: string; actingOrgId: string | null }
export type Membership = { id: string; user_id: string; org_id: string; role: MembershipRole; status: 'active' | 'removed' }

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

const roles: readonly MembershipRole[] = ['owner', 'admin', 'business', 'finance', 'legal', 'readonly']
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message) }
const denied = (): never => fail(403, 'PERMISSION_DENIED', '当前企业角色无权执行此操作')

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'INVALID_INPUT', '请求参数无效')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return fail(400, 'INVALID_INPUT', `${label}无效`)
  return value.trim()
}

function role(value: unknown): MembershipRole {
  if (!roles.includes(value as MembershipRole)) return fail(400, 'INVALID_INPUT', '成员角色无效')
  return value as MembershipRole
}

export function canManageRole(actor: MembershipRole, target: MembershipRole, next?: MembershipRole): boolean {
  if (next === 'owner' || target === 'owner') return false
  if (actor === 'owner') return true
  return actor === 'admin' && target !== 'admin' && next !== 'admin'
}

export async function audit(client: PoolClient, p: Principal, action: string, targetId: string | null, detail: Record<string, unknown> = {}, orgId = p.actingOrgId): Promise<void> {
  await client.query('INSERT INTO audit(id, org_id, actor_id, action, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), orgId, p.userId, action, targetId, JSON.stringify(detail)])
}

export async function requireMembership(client: PoolClient, p: Principal, exclusive = false): Promise<Membership> {
  if (!p.actingOrgId) return fail(409, 'ACTING_COMPANY_REQUIRED', '请先选择当前企业')
  // 所有企业成员变更和业务请求共用企业行锁，使撤权在事务边界立即生效。
  await client.query(`SELECT id FROM organizations WHERE id=$1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`, [p.actingOrgId])
  const result = await client.query<Membership>(`SELECT m.* FROM memberships m JOIN identities i ON i.id=m.user_id
    WHERE m.user_id=$1 AND m.org_id=$2 AND m.status='active' AND i.status='active'`, [p.userId, p.actingOrgId])
  if (!result.rows[0]) return fail(403, 'MEMBERSHIP_REQUIRED', '您已不具备当前企业的有效成员权限')
  return result.rows[0]
}

function requireAdmin(m: Membership): void {
  if (m.role !== 'owner' && m.role !== 'admin') denied()
}

async function selectCompany(client: PoolClient, p: Principal, orgId: string): Promise<void> {
  await requireMembership(client, { ...p, actingOrgId: orgId })
  const updated = await client.query(`UPDATE sessions SET acting_org_id=$1 WHERE id=$2 AND user_id=$3
    AND revoked_at IS NULL AND expires_at>now()`, [orgId, p.sessionId, p.userId])
  if (!updated.rowCount) fail(401, 'UNAUTHENTICATED', '会话已失效')
}

const invitationColumns = `i.id, i.email, i.org_id AS "orgId", o.name AS "orgName", i.role,
  CASE WHEN i.status='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.status END AS status,
  i.expires_at AS "expiresAt", i.invited_by AS "invitedBy", i.accepted_by AS "acceptedBy", i.revision, i.created_at AS "createdAt"`

export async function tenancyRequest(client: PoolClient, p: Principal, method: string, path: string, rawBody: unknown): Promise<unknown> {
  if (method === 'GET' && path === '/me') {
    const account = await client.query('SELECT id,name,email FROM identities WHERE id=$1 AND status=\'active\'', [p.userId])
    if (!account.rows[0]) return fail(401, 'UNAUTHENTICATED', '账号已失效')
    const companies = await client.query(`SELECT o.id,o.name,o.short_name AS "shortName",m.role FROM organizations o
      JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.created_at,o.id`, [p.userId])
    const actingOrgId = companies.rows.some((c: { id: string }) => c.id === p.actingOrgId) ? p.actingOrgId : null
    if (actingOrgId !== p.actingOrgId) await client.query('UPDATE sessions SET acting_org_id=NULL WHERE id=$1', [p.sessionId])
    return { account: account.rows[0], companies: companies.rows, actingOrgId }
  }
  if (method === 'PATCH' && path === '/me') {
    const name = text(object(rawBody).name, '姓名', 100)
    const result = await client.query('UPDATE identities SET name=$1 WHERE id=$2 AND status=\'active\' RETURNING id,name,email', [name, p.userId])
    if (!result.rows[0]) return fail(401, 'UNAUTHENTICATED', '账号已失效')
    await audit(client, p, 'profile.updated', p.userId, {}, null)
    return { account: result.rows[0] }
  }
  if (method === 'POST' && path === '/companies') {
    const name = text(object(rawBody).name, '企业名称', 120)
    const id = randomUUID()
    await client.query('INSERT INTO organizations(id,name,short_name,kind) VALUES ($1,$2,$3,\'company\')', [id, name, name.slice(0, 40)])
    await client.query('INSERT INTO memberships(id,user_id,org_id,role) VALUES ($1,$2,$3,\'owner\')', [randomUUID(), p.userId, id])
    await selectCompany(client, p, id)
    await audit(client, p, 'company.created', id, {}, id)
    return { company: { id, name, shortName: name.slice(0, 40), role: 'owner' }, actingOrgId: id }
  }
  if (method === 'POST' && path === '/acting-company') {
    const orgId = text(object(rawBody).orgId, '企业编号', 128)
    await selectCompany(client, p, orgId)
    await audit(client, p, 'session.company_selected', orgId, {}, orgId)
    return { actingOrgId: orgId }
  }
  if (method === 'GET' && path === '/my-invitations') {
    const result = await client.query(`SELECT ${invitationColumns} FROM invitations i JOIN organizations o ON o.id=i.org_id
      WHERE i.email=$1 ORDER BY i.created_at DESC`, [p.email.toLowerCase()])
    return { invitations: result.rows }
  }
  const acceptMatch = /^\/invitations\/([^/]+)\/accept$/.exec(path)
  if (method === 'POST' && acceptMatch) {
    const first = await client.query<{ org_id: string }>('SELECT org_id FROM invitations WHERE id=$1 AND email=$2', [acceptMatch[1], p.email.toLowerCase()])
    if (!first.rows[0]) return fail(404, 'NOT_FOUND', '邀请不存在')
    const orgId = first.rows[0].org_id
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId])
    const found = await client.query<{ id: string; email: string; role: MembershipRole; status: string; accepted_by: string | null; valid: boolean }>(
      'SELECT *, expires_at>now() AS valid FROM invitations WHERE id=$1 AND email=$2 FOR UPDATE', [acceptMatch[1], p.email.toLowerCase()])
    const invitation = found.rows[0]
    if (!invitation) return fail(404, 'NOT_FOUND', '邀请不存在')
    if (invitation.status !== 'pending' || !invitation.valid) return fail(409, 'INVITATION_UNAVAILABLE', '邀请已处理、撤回或失效')
    const existing = await client.query<Membership>('SELECT * FROM memberships WHERE user_id=$1 AND org_id=$2', [p.userId, orgId])
    if (existing.rows[0]?.status === 'active') return fail(409, 'ALREADY_MEMBER', '您已经是该企业成员')
    await client.query(`INSERT INTO memberships(id,user_id,org_id,role) VALUES ($1,$2,$3,$4)
      ON CONFLICT(user_id,org_id) DO UPDATE SET status='active',role=EXCLUDED.role`, [randomUUID(), p.userId, orgId, invitation.role])
    await client.query(`UPDATE invitations SET status='accepted',accepted_by=$1,revision=revision+1 WHERE id=$2`, [p.userId, invitation.id])
    await audit(client, p, 'invitation.accepted', invitation.id, { role: invitation.role }, orgId)
    return { orgId, role: invitation.role, status: 'accepted' }
  }
  if (method === 'GET' && path === '/members') {
    await requireMembership(client, p)
    const result = await client.query(`SELECT m.id,m.user_id AS "userId",i.name,i.email,m.role,m.status
      FROM memberships m JOIN identities i ON i.id=m.user_id WHERE m.org_id=$1 AND m.status='active' AND i.status='active' ORDER BY m.created_at,m.id`, [p.actingOrgId])
    return { members: result.rows }
  }
  if (method === 'GET' && path === '/invitations') {
    requireAdmin(await requireMembership(client, p))
    const result = await client.query(`SELECT ${invitationColumns} FROM invitations i JOIN organizations o ON o.id=i.org_id
      WHERE i.org_id=$1 ORDER BY i.created_at DESC`, [p.actingOrgId])
    return { invitations: result.rows }
  }
  if (method === 'POST' && path === '/invitations') {
    const actor = await requireMembership(client, p, true)
    requireAdmin(actor)
    const input = object(rawBody)
    const email = text(input.email, '邮箱', 254).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'INVALID_INPUT', '邮箱格式无效')
    const next = role(input.role)
    if (!canManageRole(actor.role, next, next)) denied()
    const member = await client.query(`SELECT m.id FROM memberships m JOIN identities i ON i.id=m.user_id
      WHERE m.org_id=$1 AND m.status='active' AND i.email=$2`, [p.actingOrgId, email])
    if (member.rowCount) return fail(409, 'ALREADY_MEMBER', '该邮箱已经是企业成员')
    await client.query(`UPDATE invitations SET status='expired',revision=revision+1 WHERE org_id=$1 AND email=$2 AND status='pending' AND expires_at<=now()`, [p.actingOrgId, email])
    const duplicate = await client.query(`SELECT id FROM invitations WHERE org_id=$1 AND email=$2 AND status='pending'`, [p.actingOrgId, email])
    if (duplicate.rowCount) return fail(409, 'INVITATION_EXISTS', '该邮箱已有待处理邀请')
    const id = randomUUID()
    const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex')
    await client.query(`INSERT INTO invitations(id,token_hash,email,org_id,role,expires_at,invited_by)
      VALUES ($1,$2,$3,$4,$5,now()+interval '7 days',$6)`, [id, tokenHash, email, p.actingOrgId, next, p.userId])
    await audit(client, p, 'invitation.created', id, { email, role: next })
    return { invitation: { id, email, orgId: p.actingOrgId, role: next, status: 'pending' } }
  }
  const withdrawMatch = /^\/invitations\/([^/]+)\/withdraw$/.exec(path)
  if (method === 'POST' && withdrawMatch) {
    const actor = await requireMembership(client, p, true)
    requireAdmin(actor)
    const result = await client.query<{ role: MembershipRole }>(`SELECT role FROM invitations WHERE id=$1 AND org_id=$2 AND status='pending' AND expires_at>now() FOR UPDATE`, [withdrawMatch[1], p.actingOrgId])
    if (!result.rows[0]) return fail(404, 'NOT_FOUND', '有效邀请不存在')
    if (!canManageRole(actor.role, result.rows[0].role)) denied()
    await client.query(`UPDATE invitations SET status='withdrawn',revision=revision+1 WHERE id=$1`, [withdrawMatch[1]])
    await audit(client, p, 'invitation.withdrawn', withdrawMatch[1])
    return { status: 'withdrawn' }
  }
  if (method === 'POST' && path === '/ownership') {
    const actor = await requireMembership(client, p, true)
    if (actor.role !== 'owner') denied()
    const userId = text(object(rawBody).userId, '新所有者编号', 128)
    if (userId === p.userId) return fail(400, 'INVALID_INPUT', '请选择其他有效成员接任所有者')
    const target = await client.query<Membership>(`SELECT m.* FROM memberships m JOIN identities i ON i.id=m.user_id WHERE m.user_id=$1 AND m.org_id=$2 AND m.status='active' AND i.status='active'`, [userId, p.actingOrgId])
    if (!target.rows[0]) return fail(404, 'NOT_FOUND', '接任成员不存在')
    await client.query(`UPDATE memberships SET role='owner' WHERE id=$1`, [target.rows[0].id])
    await client.query(`UPDATE memberships SET role='admin' WHERE id=$1`, [actor.id])
    await audit(client, p, 'ownership.transferred', userId, { previousOwnerId: p.userId })
    return { ownerUserId: userId }
  }
  const memberMatch = /^\/members\/([^/]+)$/.exec(path)
  if (memberMatch && (method === 'PATCH' || method === 'DELETE')) {
    const actor = await requireMembership(client, p, true)
    requireAdmin(actor)
    const found = await client.query<Membership>(`SELECT * FROM memberships WHERE id=$1 AND org_id=$2 AND status='active' FOR UPDATE`, [memberMatch[1], p.actingOrgId])
    const target = found.rows[0]
    if (!target) return fail(404, 'NOT_FOUND', '成员不存在')
    const next = method === 'PATCH' ? role(object(rawBody).role) : undefined
    if (!canManageRole(actor.role, target.role, next)) {
      if (target.role === 'owner') return fail(409, 'OWNERSHIP_TRANSFER_REQUIRED', '请先转交所有权，不能直接修改或移除所有者')
      denied()
    }
    if (method === 'PATCH') await client.query('UPDATE memberships SET role=$1 WHERE id=$2', [next, target.id])
    else await client.query(`UPDATE memberships SET status='removed' WHERE id=$1`, [target.id])
    await audit(client, p, method === 'PATCH' ? 'member.role_changed' : 'member.removed', target.user_id, { previousRole: target.role, ...(next ? { role: next } : {}) })
    return { id: target.id, role: next ?? target.role, status: method === 'DELETE' ? 'removed' : 'active' }
  }
  return fail(404, 'NOT_FOUND', '接口不存在')
}
