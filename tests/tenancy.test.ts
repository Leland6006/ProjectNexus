import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { AUTH_SCHEMA } from '../server/auth.ts'
import type { PoolClient } from 'pg'
import { API_METHODS } from '../src/shared/api.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { canCallBusiness, emptyBusinessDatabase, filterRoleView, persistedBusinessState, businessRequest } from '../server/business.ts'
import { canManageRole, HttpError, requireMembership, tenancyRequest, type MembershipRole, type Principal } from '../server/tenancy.ts'

const roles: MembershipRole[] = ['owner', 'admin', 'business', 'finance', 'legal', 'readonly']
const principal: Principal = { userId: 'user-a', email: 'a@example.test', name: '用户甲', sessionId: 'session-a', actingOrgId: 'org-a' }

function clientWith(handler: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | Promise<{ rows: unknown[]; rowCount?: number }>): PoolClient {
  return { query: async (sql: string, values: unknown[] = []) => handler(sql, values) } as unknown as PoolClient
}

test('所有服务器角色均禁止演示账号切换、重置、委托及未接入的外顾授权', () => {
  for (const role of roles) {
    for (const method of ['switchUser', 'resetDemo', 'setRepresentingOrg', 'grantCounsel', 'notAnApi']) assert.equal(canCallBusiness(role, method), false)
    assert.equal(canCallBusiness(role, 'getState'), true)
  }
})

test('只读角色不能执行任何业务写操作', () => {
  for (const method of API_METHODS) assert.equal(canCallBusiness('readonly', method), method === 'getState', method)
})

test('财务和法务遵守业务写入边界，只有商务管理角色可以邀请交易对方', () => {
  for (const method of ['createContract', 'shareContract', 'updateClauses', 'updatePaymentTerms', 'restoreVersion', 'confirmFinal', 'approveProposal', 'createTransaction', 'updateTransaction']) {
    assert.equal(canCallBusiness('finance', method), false, method)
  }
  for (const method of ['createMilestone', 'updateMilestone', 'confirmClaim', 'runAgents']) assert.equal(canCallBusiness('finance', method), true)
  for (const method of ['createTransaction', 'updateTransaction', 'createMilestone', 'updateMilestone', 'confirmClaim', 'runAgents', 'approveProposal', 'acceptInvitation']) {
    assert.equal(canCallBusiness('legal', method), false, method)
  }
  for (const method of ['createContract', 'updateClauses', 'createSuggestion', 'saveVersion']) assert.equal(canCallBusiness('legal', method), true)
  for (const role of roles) assert.equal(canCallBusiness(role, 'inviteCounterparty'), ['owner', 'admin', 'business'].includes(role))
})

test('成员管理分级以及所有权必须专门转交', () => {
  for (const actor of roles) {
    assert.equal(canManageRole(actor, 'owner'), false)
    assert.equal(canManageRole(actor, 'business', 'owner'), false)
  }
  assert.equal(canManageRole('owner', 'admin', 'legal'), true)
  assert.equal(canManageRole('owner', 'business', 'admin'), true)
  assert.equal(canManageRole('admin', 'admin', 'legal'), false)
  assert.equal(canManageRole('admin', 'business', 'admin'), false)
  assert.equal(canManageRole('admin', 'business', 'finance'), true)
  for (const actor of ['business', 'finance', 'legal', 'readonly'] as const) assert.equal(canManageRole(actor, 'business', 'legal'), false)
})

test('服务器业务空库不注入演示数据，持久化不含权限目录', () => {
  const db = emptyBusinessDatabase()
  for (const [key, value] of Object.entries(db)) if (key !== 'schemaVersion') assert.deepEqual(value, [], key)
  db.users.push({ id: 'u', name: '甲', orgId: 'o', role: 'business', title: 'owner' })
  db.organizations.push({ id: 'o', name: '虚构企业甲', shortName: '甲', kind: 'company' })
  const payload = persistedBusinessState(db)
  assert.equal('users' in payload, false)
  assert.equal('organizations' in payload, false)
  assert.deepEqual(payload.transactions, [])
})

test('法务和只读视图隐藏财务集合与财务派生活动且不暴露演示目录', () => {
  const db = emptyBusinessDatabase()
  db.users.push({ id: 'u', name: '甲', orgId: 'o', role: 'business', title: 'owner' })
  db.organizations.push({ id: 'o', name: '虚构企业甲', shortName: '甲', kind: 'company' })
  const state = buildViewState(db, 'u', { demoDirectory: true })
  state.cashAccounts = [{ id: 'cash', orgId: 'o', label: '内部现金', openingBalance: 990, asOf: '2026-01-01' }]
  state.activities = [{ id: 'a', transactionId: 't', contractId: null, actorId: 'u', orgId: 'o', type: 'proposal_created', summary: '现金缺口990', visibility: 'internal', createdAt: '2026-01-01' }]
  for (const role of roles) {
    const view = filterRoleView(state, role)
    assert.equal(view.demoAccounts, null)
    assert.equal(view.cashAccounts.length, role === 'legal' || role === 'readonly' ? 0 : 1)
    if (role === 'legal' || role === 'readonly') {
      assert.deepEqual(view.activities, [])
      assert.deepEqual(view.costItems, [])
      assert.deepEqual(view.claims, [])
      assert.deepEqual(view.proposals, [])
    }
  }
  assert.equal(state.cashAccounts.length, 1)
})

test('未选企业拒绝业务，成员被移除后每次请求重新验证', async () => {
  let calls = 0
  const client = clientWith(() => { calls++; return { rows: [] } })
  await assert.rejects(requireMembership(client, { ...principal, actingOrgId: null }), (error: unknown) => error instanceof HttpError && error.code === 'ACTING_COMPANY_REQUIRED')
  assert.equal(calls, 0)
  await assert.rejects(businessRequest(client, principal, { method: 'getState', args: [] }), (error: unknown) => error instanceof HttpError && error.code === 'MEMBERSHIP_REQUIRED')
  assert.equal(calls, 2)
})

test('业务请求从SQL重建当前身份，忽略快照中的过期企业与演示账号', async () => {
  const db = emptyBusinessDatabase()
  db.organizations = [{ id: 'victim-org', name: '不相关企业', shortName: '无关', kind: 'company' }]
  db.users = [{ id: principal.userId, name: '伪造身份', orgId: 'victim-org', role: 'business', title: 'owner' }]
  const client = clientWith((sql) => {
    if (sql.includes('SELECT m.*')) return { rows: [{ id: 'm', user_id: principal.userId, org_id: 'org-a', role: 'readonly', status: 'active' }] }
    if (sql.startsWith('SELECT payload')) return { rows: [{ payload: db }] }
    if (sql.startsWith('SELECT id,name FROM identities')) return { rows: [{ id: principal.userId, name: '当前真实姓名' }] }
    if (sql.includes('SELECT id,name,short_name')) return { rows: [{ id: 'org-a', name: '当前企业', shortName: '当前', kind: 'company' }] }
    if (sql.includes('SELECT i.id,i.name,m.org_id')) return { rows: [{ id: principal.userId, name: '当前真实姓名', org_id: 'org-a', role: 'readonly' }] }
    return { rows: [] }
  })
  const result = await businessRequest(client, principal, { method: 'getState', args: [] })
  assert.equal(result.ok, true)
  assert.equal(result.state.demoAccounts, null)
  assert.deepEqual(result.state.organizations.map((o) => o.id), ['org-a'])
  assert.equal(result.state.users[0].orgId, 'org-a')
  assert.equal(result.state.users[0].name, '当前真实姓名')
  await assert.rejects(businessRequest(client, principal, { method: 'createTransaction', args: [{ actingRole: 'owner' }] }), (error: unknown) => error instanceof HttpError && error.status === 403)
})

test('邀请领取用认证邮箱查询并先锁企业再锁邀请，已撤回邀请不能加入', async () => {
  const queries: string[] = []
  const client = clientWith((sql, values) => {
    queries.push(sql)
    if (sql.startsWith('SELECT org_id FROM invitations')) {
      assert.deepEqual(values, ['invite-a', principal.email])
      return { rows: [{ org_id: 'org-a' }] }
    }
    if (sql.includes('FROM invitations') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'invite-a', role: 'business', status: 'withdrawn', valid: true }] }
    return { rows: [] }
  })
  await assert.rejects(tenancyRequest(client, principal, 'POST', '/invitations/invite-a/accept', { email: 'someone-else@example.test', userId: 'victim', role: 'owner' }), (error: unknown) => error instanceof HttpError && error.code === 'INVITATION_UNAVAILABLE')
  assert.ok(queries[1].includes('organizations'))
  assert.ok(queries[2].includes('invitations'))
  assert.equal(queries.some((sql) => sql.startsWith('INSERT')), false)
})

test('过期邀请即便仍标记pending也不能领取', async () => {
  const client = clientWith((sql) => {
    if (sql.startsWith('SELECT org_id FROM invitations')) return { rows: [{ org_id: 'org-a' }] }
    if (sql.includes('FROM invitations') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'expired', role: 'business', status: 'pending', valid: false }] }
    if (sql.startsWith('INSERT')) assert.fail('过期邀请不得写入成员')
    return { rows: [] }
  })
  await assert.rejects(tenancyRequest(client, principal, 'POST', '/invitations/expired/accept', {}), (error: unknown) => error instanceof HttpError && error.code === 'INVITATION_UNAVAILABLE')
})

test('领取邀请仅使用数据库角色且成员插入、邀请消费、审计同事务执行', async () => {
  const writes: { sql: string; values: unknown[] }[] = []
  const client = clientWith((sql, values) => {
    if (sql.startsWith('SELECT org_id FROM invitations')) return { rows: [{ org_id: 'org-a' }] }
    if (sql.includes('FROM invitations') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'invite-a', role: 'legal', status: 'pending', valid: true }] }
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) writes.push({ sql, values })
    return { rows: [] }
  })
  const result = await tenancyRequest(client, principal, 'POST', '/invitations/invite-a/accept', { role: 'owner', orgId: 'org-victim' })
  assert.deepEqual(result, { orgId: 'org-a', role: 'legal', status: 'accepted' })
  assert.ok(writes[0].sql.includes('INSERT INTO memberships'))
  assert.equal(writes[0].values[1], principal.userId)
  assert.equal(writes[0].values[2], 'org-a')
  assert.equal(writes[0].values[3], 'legal')
  assert.ok(writes[1].sql.includes('UPDATE invitations'))
  assert.ok(writes[2].sql.includes('INSERT INTO audit'))
  assert.equal(writes[2].values[3], 'invitation.accepted')
})

test('所有权先授予有效接任者再降级原所有者并写审计', async () => {
  const writes: { sql: string; values: unknown[] }[] = []
  const client = clientWith((sql, values) => {
    if (sql.includes('SELECT m.*')) return { rows: [values[0] === 'new-owner'
      ? { id: 'new-membership', user_id: 'new-owner', org_id: 'org-a', role: 'business', status: 'active' }
      : { id: 'old-owner', user_id: principal.userId, org_id: 'org-a', role: 'owner', status: 'active' }] }
    if (sql.startsWith('UPDATE') || sql.startsWith('INSERT')) writes.push({ sql, values })
    return { rows: [] }
  })
  assert.deepEqual(await tenancyRequest(client, principal, 'POST', '/ownership', { userId: 'new-owner' }), { ownerUserId: 'new-owner' })
  assert.ok(writes[0].sql.includes("role='owner'"))
  assert.deepEqual(writes[0].values, ['new-membership'])
  assert.ok(writes[1].sql.includes("role='admin'"))
  assert.deepEqual(writes[1].values, ['old-owner'])
  assert.equal(writes[2].values[3], 'ownership.transferred')
})

test('企业成员校验先锁企业再读最新有效身份与角色', async () => {
  const queries: string[] = []
  const client = clientWith((sql, values) => {
    queries.push(sql)
    if (sql.includes('SELECT m.*')) {
      assert.ok(sql.includes("m.status='active' AND i.status='active'"))
      assert.deepEqual(values, [principal.userId, principal.actingOrgId])
      return { rows: [{ id: 'm', user_id: principal.userId, org_id: 'org-a', role: 'legal', status: 'active' }] }
    }
    return { rows: [] }
  })
  assert.equal((await requireMembership(client, principal)).role, 'legal')
  assert.ok(queries[0].includes('organizations'))
  assert.ok(queries[0].endsWith('FOR SHARE'))
  assert.ok(queries[1].includes('identities'))
  queries.length = 0
  await requireMembership(client, principal, true)
  assert.ok(queries[0].endsWith('FOR UPDATE'))
})

test('无目标企业成员资格或已撤销会话不能切换企业', async () => {
  let changed = false
  const missingMember = clientWith((sql) => {
    if (sql.startsWith('UPDATE sessions')) changed = true
    return { rows: [] }
  })
  await assert.rejects(tenancyRequest(missingMember, principal, 'POST', '/acting-company', { orgId: 'other-org', actingRole: 'owner' }), (error: unknown) => error instanceof HttpError && error.code === 'MEMBERSHIP_REQUIRED')
  assert.equal(changed, false)
  const revoked = clientWith((sql, values) => {
    if (sql.includes('SELECT m.*')) return { rows: [{ id: 'm', user_id: principal.userId, org_id: 'other-org', role: 'business', status: 'active' }] }
    if (sql.startsWith('UPDATE sessions')) {
      assert.deepEqual(values, ['other-org', principal.sessionId, principal.userId])
      assert.ok(sql.includes('revoked_at IS NULL AND expires_at>now()'))
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('INSERT INTO audit')) assert.fail('失效会话不得记录切换成功')
    return { rows: [] }
  })
  await assert.rejects(tenancyRequest(revoked, principal, 'POST', '/acting-company', { orgId: 'other-org' }), (error: unknown) => error instanceof HttpError && error.code === 'UNAUTHENTICATED')
})

test('真实SQL邀请列表统一orgName且企业切换只修改当前会话，目录排除停用身份', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'))
  await db.exec(AUTH_SCHEMA)
  const client = clientWith(async (sql, values) => {
    const result = await db.query(sql, values)
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 }
  })
  await db.query('INSERT INTO identities(id,oidc_sub,email,name) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [principal.userId, 'sub-a', principal.email, principal.name, 'disabled-user', 'sub-disabled', 'disabled@example.test', '已停用成员'])
  await db.query(`INSERT INTO sessions(id,user_id,token_hash,access_cipher,expires_at)
    VALUES ($1,$2,'hash-current','cipher',now()+interval '1 hour'),('other-session',$2,'hash-other','cipher',now()+interval '1 hour')`, [principal.sessionId, principal.userId])
  const first = await tenancyRequest(client, principal, 'POST', '/companies', { name: '虚构企业甲' }) as { actingOrgId: string }
  const firstPrincipal = { ...principal, actingOrgId: first.actingOrgId }
  await tenancyRequest(client, firstPrincipal, 'POST', '/invitations', { email: principal.email.replace('a@', 'invitee@'), role: 'legal' })
  const adminList = await tenancyRequest(client, firstPrincipal, 'GET', '/invitations', {}) as { invitations: Record<string, unknown>[] }
  const invitee = { ...principal, email: principal.email.replace('a@', 'invitee@') }
  const personalList = await tenancyRequest(client, invitee, 'GET', '/my-invitations', {}) as { invitations: Record<string, unknown>[] }
  for (const result of [adminList, personalList]) {
    assert.equal(result.invitations.length, 1)
    assert.equal(result.invitations[0].orgName, '虚构企业甲')
    assert.equal(result.invitations[0].orgId, first.actingOrgId)
    assert.equal('companyName' in result.invitations[0], false)
  }
  await db.query(`INSERT INTO memberships(id,user_id,org_id,role) VALUES ('disabled-membership','disabled-user',$1,'business')`, [first.actingOrgId])
  await db.query(`UPDATE identities SET status='disabled' WHERE id='disabled-user'`)
  const members = await tenancyRequest(client, firstPrincipal, 'GET', '/members', {}) as { members: { userId: string }[] }
  assert.deepEqual(members.members.map((m) => m.userId), [principal.userId])
  await db.query(`UPDATE sessions SET acting_org_id=$1 WHERE id='other-session'`, [first.actingOrgId])
  const second = await tenancyRequest(client, firstPrincipal, 'POST', '/companies', { name: '虚构企业乙' }) as { actingOrgId: string }
  const sessions = await db.query<{ id: string; acting_org_id: string }>('SELECT id,acting_org_id FROM sessions ORDER BY id')
  assert.equal(sessions.rows.find((s) => s.id === principal.sessionId)?.acting_org_id, second.actingOrgId)
  assert.equal(sessions.rows.find((s) => s.id === 'other-session')?.acting_org_id, first.actingOrgId)
})

test('创建邀请忽略请求声明的权限，数据库中的普通成员不能发邀请', async () => {
  const client = clientWith((sql) => sql.includes('SELECT m.*') ? { rows: [{ id: 'm', user_id: principal.userId, org_id: 'org-a', role: 'business', status: 'active' }] } : { rows: [] })
  await assert.rejects(tenancyRequest(client, principal, 'POST', '/invitations', { email: 'b@example.test', role: 'business', actingRole: 'owner', userId: 'owner-user' }), (error: unknown) => error instanceof HttpError && error.status === 403)
})
