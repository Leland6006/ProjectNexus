import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { PoolClient } from 'pg'
import { AUTH_SCHEMA, IdentityService } from '../server/auth.ts'
import { businessRequest } from '../server/business.ts'
import { HttpError, tenancyRequest, type MembershipRole, type Principal } from '../server/tenancy.ts'
import type { ViewState } from '../src/shared/types.ts'

// PostgreSQL WASM 执行真实 SQL；仅适配 pg 返回形状，不模拟查询或权限结果。
// 单连接内存库不验证多连接锁竞争、生产持久化及 OIDC 联网登录。
function adapt(database: { query: PGlite['query'] }): PoolClient {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      const result = await database.query(sql, values)
      return { rows: result.rows, rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0) }
    }
  } as unknown as PoolClient
}

async function fixture(t: TestContext) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'))
  await db.exec(AUTH_SCHEMA)
  const accounts: Principal[] = []
  for (const [index, name] of ['测试甲', '测试乙', '测试丙'].entries()) {
    const userId = randomUUID()
    const sessionId = randomUUID()
    const email = `identity-${index}@example.test`
    await db.query('INSERT INTO identities(id,oidc_sub,email,name) VALUES ($1,$2,$3,$4)', [userId, `test-sub-${index}`, email, name])
    await db.query(`INSERT INTO sessions(id,user_id,token_hash,access_cipher,expires_at)
      VALUES ($1,$2,$3,'无需调用身份服务',now()+interval '1 hour')`, [sessionId, userId, `test-token-${index}`])
    accounts.push({ userId, email, name, sessionId, actingOrgId: null })
  }
  const [alice, bob, charlie] = accounts as [Principal, Principal, Principal]
  const transaction = <T>(run: (client: PoolClient) => Promise<T>) => db.transaction((tx) => run(adapt(tx)))
  const tenancy = <T = Record<string, unknown>>(p: Principal, method: string, path: string, body: unknown = {}) =>
    transaction((client) => tenancyRequest(client, p, method, path, body)) as Promise<T>
  const business = async (p: Principal, method = 'getState', ...args: unknown[]): Promise<ViewState> => {
    const result = await transaction((client) => businessRequest(client, p, { method, args }))
    if (!result.ok) assert.fail(`${result.code}: ${result.message}`)
    return result.state
  }
  const company = async (p: Principal, name: string) => {
    const result = await tenancy<{ actingOrgId: string }>(p, 'POST', '/companies', { name })
    p.actingOrgId = result.actingOrgId
    return result.actingOrgId
  }
  const select = async (p: Principal, orgId: string) => {
    await tenancy(p, 'POST', '/acting-company', { orgId })
    p.actingOrgId = orgId
  }
  const invite = async (p: Principal, email: string, role: MembershipRole = 'business') => {
    const result = await tenancy<{ invitation: { id: string; email: string; role: MembershipRole } }>(p, 'POST', '/invitations', { email, role })
    return result.invitation
  }
  const join = async (owner: Principal, person: Principal, role: MembershipRole = 'business') => {
    const invitation = await invite(owner, person.email, role)
    await tenancy(person, 'POST', `/invitations/${invitation.id}/accept`)
    await select(person, owner.actingOrgId!)
    const result = await db.query<{ id: string }>('SELECT id FROM memberships WHERE user_id=$1 AND org_id=$2', [person.userId, owner.actingOrgId])
    return result.rows[0].id
  }
  return { db, alice, bob, charlie, tenancy, business, company, select, invite, join }
}

async function rejectsHttp(request: Promise<unknown>, status: number, code: string) {
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return true
  })
}

const transactionInput = (counterpartyOrgId: string) => ({
  name: '真实数据库测试交易', type: '采购', counterpartyOrgId, amount: 10000,
  expectedSignDate: '2026-12-01', description: '权限集成验证'
})

test('PostgreSQL：停用身份立即拒绝旧 Principal 和本地会话，不访问 OIDC', async (t) => {
  const { db, alice, tenancy, business, company } = await fixture(t)
  await company(alice, '停用身份测试企业')
  const oldPrincipal = { ...alice }
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await db.query('UPDATE sessions SET token_hash=$1 WHERE id=$2', [tokenHash, alice.sessionId])
  await db.query("UPDATE identities SET status='disabled' WHERE id=$1", [alice.userId])
  await rejectsHttp(tenancy(oldPrincipal, 'GET', '/me'), 401, 'UNAUTHENTICATED')
  await rejectsHttp(business(oldPrincipal), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(business(oldPrincipal, 'sendMessage', 'unknown', '停用后写入', 'shared'), 403, 'MEMBERSHIP_REQUIRED')
  // 无配置接收者只执行真实 authenticate 的数据库拒绝分支；误入 OIDC 分支会让测试失败。
  await rejectsHttp(IdentityService.prototype.authenticate.call({} as IdentityService, adapt(db), `Bearer ${token}`), 401, 'SESSION_EXPIRED')
})

test('PostgreSQL：会话令牌哈希唯一且关联身份，过期或撤销会话在联网前拒绝', async (t) => {
  const { db, alice } = await fixture(t)
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await db.query('UPDATE sessions SET token_hash=$1 WHERE id=$2', [tokenHash, alice.sessionId])
  const stored = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE id=$1', [alice.sessionId])
  assert.equal(stored.rows[0].token_hash, tokenHash)
  assert.notEqual(stored.rows[0].token_hash, token)
  await assert.rejects(db.query(`INSERT INTO sessions(id,user_id,token_hash,access_cipher,expires_at)
    VALUES ($1,$2,$3,'unused',now()+interval '1 hour')`, [randomUUID(), alice.userId, tokenHash]), (error: unknown) => {
    assert.equal((error as { code: string }).code, '23505')
    return true
  })
  await assert.rejects(db.query(`INSERT INTO sessions(id,user_id,token_hash,access_cipher,expires_at)
    VALUES ($1,$2,$3,'unused',now()+interval '1 hour')`, [randomUUID(), '不存在的身份', 'other-token-hash']), (error: unknown) => {
    assert.equal((error as { code: string }).code, '23503')
    return true
  })
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [alice.sessionId])
  await rejectsHttp(IdentityService.prototype.authenticate.call({} as IdentityService, adapt(db), `Bearer ${token}`), 401, 'SESSION_EXPIRED')
  await db.query("UPDATE sessions SET expires_at=now()+interval '1 hour',revoked_at=now() WHERE id=$1", [alice.sessionId])
  await rejectsHttp(IdentityService.prototype.authenticate.call({} as IdentityService, adapt(db), `Bearer ${token}`), 401, 'SESSION_EXPIRED')
})

test('PostgreSQL：新账号企业为空，允许多企业与切换，其他账号不能冒选', async (t) => {
  const { db, alice, bob, tenancy, business, company, select } = await fixture(t)
  const initial = await tenancy<{ companies: unknown[]; actingOrgId: string | null }>(alice, 'GET', '/me')
  assert.deepEqual(initial.companies, [])
  assert.equal(initial.actingOrgId, null)
  await rejectsHttp(business(alice), 409, 'ACTING_COMPANY_REQUIRED')
  const first = await company(alice, '测试企业甲')
  const state = await business(alice)
  for (const key of ['transactions', 'contracts', 'messages', 'milestones', 'costItems', 'cashAccounts', 'claims', 'proposals'] as const) assert.deepEqual(state[key], [])
  assert.equal(state.demoAccounts, null)
  assert.deepEqual(state.users.map((u) => u.id), [alice.userId])
  assert.deepEqual(state.organizations.map((o) => o.id), [first])
  const second = await company(alice, '测试企业乙')
  assert.notEqual(first, second)
  const me = await tenancy<{ companies: { id: string; role: string }[] }>(alice, 'GET', '/me')
  assert.deepEqual(new Set(me.companies.map((c) => c.id)), new Set([first, second]))
  assert.ok(me.companies.every((c) => c.role === 'owner'))
  await select(alice, first)
  const session = await db.query<{ acting_org_id: string }>('SELECT acting_org_id FROM sessions WHERE id=$1', [alice.sessionId])
  assert.equal(session.rows[0].acting_org_id, first)
  await rejectsHttp(tenancy(bob, 'POST', '/acting-company', { orgId: first, userId: alice.userId, role: 'owner' }), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(business({ ...bob, actingOrgId: first }), 403, 'MEMBERSHIP_REQUIRED')
  const otherSession = await db.query<{ acting_org_id: string | null }>('SELECT acting_org_id FROM sessions WHERE id=$1', [bob.sessionId])
  assert.equal(otherSession.rows[0].acting_org_id, null)
})

test('PostgreSQL：邀请绑定认证邮箱，重复创建或领取不重复成员与审计', async (t) => {
  const { db, alice, bob, charlie, tenancy, company, invite } = await fixture(t)
  const orgId = await company(alice, '邀请测试企业')
  const invitation = await invite(alice, bob.email.toUpperCase(), 'legal')
  assert.equal(invitation.email, bob.email)
  await rejectsHttp(invite(alice, bob.email, 'admin'), 409, 'INVITATION_EXISTS')
  const unrelated = await tenancy<{ invitations: unknown[] }>(charlie, 'GET', '/my-invitations')
  assert.deepEqual(unrelated.invitations, [])
  await rejectsHttp(tenancy(charlie, 'POST', `/invitations/${invitation.id}/accept`, { email: bob.email, userId: bob.userId, role: 'owner' }), 404, 'NOT_FOUND')
  await tenancy(bob, 'POST', `/invitations/${invitation.id}/accept`, { email: charlie.email, userId: charlie.userId, role: 'owner' })
  await rejectsHttp(tenancy(bob, 'POST', `/invitations/${invitation.id}/accept`), 409, 'INVITATION_UNAVAILABLE')
  await rejectsHttp(invite(alice, bob.email), 409, 'ALREADY_MEMBER')
  const membership = await db.query<{ user_id: string; role: string }>('SELECT user_id,role FROM memberships WHERE org_id=$1 AND user_id<>$2', [orgId, alice.userId])
  assert.deepEqual(membership.rows, [{ user_id: bob.userId, role: 'legal' }])
  const accepted = await db.query<{ status: string; accepted_by: string; revision: number }>('SELECT status,accepted_by,revision FROM invitations WHERE id=$1', [invitation.id])
  assert.deepEqual(accepted.rows, [{ status: 'accepted', accepted_by: bob.userId, revision: 2 }])
  const audits = await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM audit WHERE action='invitation.accepted' AND target_id=$1", [invitation.id])
  assert.equal(audits.rows[0].count, 1)
})

test('PostgreSQL：撤回与失效邀请不能领取，过期后可重新邀请', async (t) => {
  const { db, alice, bob, charlie, tenancy, company, invite } = await fixture(t)
  await company(alice, '邀请生命周期企业')
  const withdrawn = await invite(alice, bob.email)
  await tenancy(alice, 'POST', `/invitations/${withdrawn.id}/withdraw`)
  await rejectsHttp(tenancy(bob, 'POST', `/invitations/${withdrawn.id}/accept`), 409, 'INVITATION_UNAVAILABLE')
  await rejectsHttp(tenancy(alice, 'POST', `/invitations/${withdrawn.id}/withdraw`), 404, 'NOT_FOUND')
  const expired = await invite(alice, charlie.email, 'finance')
  await db.query("UPDATE invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [expired.id])
  const inbox = await tenancy<{ invitations: { id: string; status: string }[] }>(charlie, 'GET', '/my-invitations')
  assert.equal(inbox.invitations.find((i) => i.id === expired.id)?.status, 'expired')
  await rejectsHttp(tenancy(charlie, 'POST', `/invitations/${expired.id}/accept`), 409, 'INVITATION_UNAVAILABLE')
  const replacement = await invite(alice, charlie.email, 'readonly')
  assert.notEqual(replacement.id, expired.id)
  await tenancy(charlie, 'POST', `/invitations/${replacement.id}/accept`)
  const old = await db.query<{ status: string }>('SELECT status FROM invitations WHERE id=$1', [expired.id])
  assert.equal(old.rows[0].status, 'expired')
  const rejectedMember = await db.query('SELECT id FROM memberships WHERE user_id=$1', [bob.userId])
  assert.deepEqual(rejectedMember.rows, [])
})

test('PostgreSQL：所有者不可直接降级移除，管理员不能改所有者，专用接口转交', async (t) => {
  const { db, alice, bob, charlie, tenancy, company, join } = await fixture(t)
  const orgId = await company(alice, '所有权测试企业')
  const bobMembership = await join(alice, bob, 'admin')
  const charlieMembership = await join(alice, charlie, 'business')
  const owner = await db.query<{ id: string }>('SELECT id FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, alice.userId])
  const ownerPath = `/members/${owner.rows[0].id}`
  for (const actor of [alice, bob]) {
    await rejectsHttp(tenancy(actor, 'DELETE', ownerPath), 409, 'OWNERSHIP_TRANSFER_REQUIRED')
    await rejectsHttp(tenancy(actor, 'PATCH', ownerPath, { role: 'readonly' }), 409, 'OWNERSHIP_TRANSFER_REQUIRED')
  }
  await rejectsHttp(tenancy(bob, 'PATCH', `/members/${charlieMembership}`, { role: 'admin' }), 403, 'PERMISSION_DENIED')
  await rejectsHttp(tenancy(bob, 'DELETE', `/members/${bobMembership}`), 403, 'PERMISSION_DENIED')
  await rejectsHttp(tenancy(bob, 'POST', '/ownership', { userId: bob.userId }), 403, 'PERMISSION_DENIED')
  await tenancy(alice, 'POST', '/ownership', { userId: bob.userId })
  const owners = await db.query<{ user_id: string }>("SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'", [orgId])
  assert.deepEqual(owners.rows, [{ user_id: bob.userId }])
  const previous = await db.query<{ role: string }>('SELECT role FROM memberships WHERE id=$1', [owner.rows[0].id])
  assert.equal(previous.rows[0].role, 'admin')
  await rejectsHttp(tenancy(alice, 'POST', '/ownership', { userId: charlie.userId }), 403, 'PERMISSION_DENIED')
})

test('PostgreSQL：角色变更和移除立即撤销旧 Principal 写权限，重新邀请复用成员', async (t) => {
  const { db, alice, bob, charlie, tenancy, business, company, join, invite, select } = await fixture(t)
  const orgId = await company(alice, '动态权限测试企业')
  const otherOrg = await company(charlie, '动态权限交易对方')
  const membershipId = await join(alice, bob)
  const stalePrincipal = { ...bob }
  const created = await business(bob, 'createTransaction', transactionInput(otherOrg))
  const txId = created.transactions[0].id
  await tenancy(alice, 'PATCH', `/members/${membershipId}`, { role: 'readonly' })
  const beforeDenied = await db.query<{ revision: number }>("SELECT revision::integer AS revision FROM business_state WHERE id='singleton'")
  assert.equal((await business(stalePrincipal)).transactions[0].id, txId)
  for (const [method, args] of [
    ['updateTransaction', [txId, { name: '越权修改' }]],
    ['sendMessage', [txId, '越权消息', 'internal']],
    ['createMilestone', [{ transactionId: txId, name: '越权节点', responsibleOrgId: orgId, dueDate: '2026-12-01' }]],
    ['switchUser', [alice.userId]], ['resetDemo', []]
  ] as const) await rejectsHttp(business(stalePrincipal, method, ...args), 403, 'PERMISSION_DENIED')
  const afterDenied = await db.query<{ revision: number }>("SELECT revision::integer AS revision FROM business_state WHERE id='singleton'")
  assert.equal(afterDenied.rows[0].revision, beforeDenied.rows[0].revision)
  await tenancy(alice, 'DELETE', `/members/${membershipId}`)
  await rejectsHttp(business(stalePrincipal), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(business(stalePrincipal, 'updateTransaction', txId, { name: '移除后写入' }), 403, 'MEMBERSHIP_REQUIRED')
  const me = await tenancy<{ actingOrgId: string | null; companies: unknown[] }>(stalePrincipal, 'GET', '/me')
  assert.equal(me.actingOrgId, null)
  assert.deepEqual(me.companies, [])
  const session = await db.query<{ acting_org_id: string | null }>('SELECT acting_org_id FROM sessions WHERE id=$1', [bob.sessionId])
  assert.equal(session.rows[0].acting_org_id, null)
  const invitation = await invite(alice, bob.email, 'legal')
  await tenancy(bob, 'POST', `/invitations/${invitation.id}/accept`)
  await select(bob, orgId)
  const restored = await db.query<{ id: string; role: string; status: string }>('SELECT id,role,status FROM memberships WHERE user_id=$1 AND org_id=$2', [bob.userId, orgId])
  assert.deepEqual(restored.rows, [{ id: membershipId, role: 'legal', status: 'active' }])
})

test('PostgreSQL：跨交易读写隔离且业务快照不保存身份和企业目录', async (t) => {
  const { db, alice, bob, charlie, business, company, select } = await fixture(t)
  const orgA = await company(alice, '交易发起企业')
  const orgB = await company(bob, '交易对方企业')
  const orgC = await company(charlie, '无关第三方企业')
  const result = await business(alice, 'createTransaction', transactionInput(orgB))
  const txId = result.transactions[0].id
  const contractState = await business(alice, 'createContract', txId, '未共享合同')
  const contractId = contractState.contracts[0].id
  await business(alice, 'sendMessage', txId, '内部消息', 'internal')
  const foreign = await business(charlie)
  for (const key of ['transactions', 'contracts', 'messages', 'activities'] as const) assert.deepEqual(foreign[key], [])
  assert.deepEqual(foreign.organizations.map((o) => o.id), [orgC])
  assert.deepEqual(foreign.users.map((u) => u.id), [charlie.userId])
  for (const [method, args] of [
    ['updateTransaction', [txId, { name: '第三方篡改' }]],
    ['sendMessage', [txId, '第三方消息', 'shared']],
    ['createContract', [txId, '第三方合同']],
    ['saveVersion', [contractId, '越权保存']]
  ] as const) await rejectsHttp(business(charlie, method, ...args), 404, 'NOT_FOUND')
  assert.deepEqual((await business(bob)).transactions, [])
  await business(alice, 'inviteCounterparty', txId)
  assert.equal((await business(bob)).transactions[0].id, txId)
  assert.deepEqual((await business(bob)).contracts, [])
  assert.deepEqual((await business(bob)).messages, [])
  const orgA2 = await company(alice, '同账号另一个企业')
  assert.deepEqual((await business(alice)).transactions, [])
  await rejectsHttp(business(alice, 'updateTransaction', txId, { name: '跨当前企业修改' }), 404, 'NOT_FOUND')
  await select(alice, orgA)
  assert.equal((await business(alice)).transactions[0].name, '真实数据库测试交易')
  const persisted = await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM business_state WHERE id='singleton'")
  const payload = persisted.rows[0].payload
  for (const key of ['users', 'organizations', 'identities', 'memberships', 'sessions']) assert.equal(key in payload, false, key)
  assert.equal(JSON.stringify(payload).includes(alice.email), false)
  assert.notEqual(orgA2, orgA)
})

test('PostgreSQL：财务可写履约但不能改合同或交易，法务和只读看不到财务集合', async (t) => {
  const { db, alice, bob, charlie, tenancy, business, company, join } = await fixture(t)
  const orgId = await company(alice, '财务权限企业')
  const counterparty = await company(charlie, '财务权限交易对方')
  const memberId = await join(alice, bob, 'finance')
  const state = await business(alice, 'createTransaction', transactionInput(counterparty))
  const txId = state.transactions[0].id
  const snapshot = await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM business_state WHERE id='singleton'")
  const payload = snapshot.rows[0].payload
  payload.cashAccounts = [{ id: 'cash-a', orgId, label: '内部现金', openingBalance: 900, asOf: '2026-10-20' }, { id: 'cash-other', orgId: counterparty, label: '对方现金', openingBalance: 100, asOf: '2026-10-20' }]
  payload.costItems = [{ id: 'cost-a', transactionId: txId, orgId, name: '内部成本', amount: 100, dueDate: '2026-12-01', status: 'committed', visibility: 'internal', createdBy: alice.userId, createdAt: '2026-10-20' }]
  payload.claims = [{ id: 'claim-a', orgId, transactionId: txId, key: 'cash.test', label: '内部现金信息', value: '900', numeric: 900, unit: '元', status: 'inferred', source: { kind: 'ledger' }, asOf: '2026-10-20', visibility: 'internal', supersededById: null, confirmedBy: null, confirmedAt: null }]
  payload.proposals = [{ id: 'proposal-a', transactionId: txId, contractId: null, orgId, title: '内部财务建议', rationale: '现金900', actions: [], claimIds: ['claim-a'], eventId: null, status: 'pending', createdBy: alice.userId, createdAt: '2026-10-20', resolvedBy: null, resolvedAt: null, baseVersionId: null }]
  await db.query("UPDATE business_state SET payload=$1 WHERE id='singleton'", [JSON.stringify(payload)])
  const finance = await business(bob)
  assert.deepEqual(finance.cashAccounts.map((a) => a.id), ['cash-a'])
  for (const key of ['costItems', 'claims', 'proposals'] as const) assert.equal(finance[key].length, 1)
  const milestone = await business(bob, 'createMilestone', { transactionId: txId, name: '财务节点', responsibleOrgId: orgId, dueDate: '2026-12-01', paymentAmount: 100 })
  assert.equal(milestone.milestones.length, 1)
  await business(bob, 'confirmClaim', 'claim-a')
  for (const [method, args] of [
    ['createTransaction', [transactionInput(counterparty)]],
    ['updateTransaction', [txId, { amount: 1 }]],
    ['createContract', [txId, '财务越权合同']],
    ['approveProposal', ['proposal-a']]
  ] as const) await rejectsHttp(business(bob, method, ...args), 403, 'PERMISSION_DENIED')
  for (const role of ['legal', 'readonly']) {
    await tenancy(alice, 'PATCH', `/members/${memberId}`, { role })
    const hidden = await business(bob)
    for (const key of ['cashAccounts', 'costItems', 'claims', 'proposals'] as const) assert.deepEqual(hidden[key], [], `${role}:${key}`)
    await rejectsHttp(business(bob, 'confirmClaim', 'claim-a'), 403, 'PERMISSION_DENIED')
  }
  const outsider = await business(charlie)
  assert.deepEqual(outsider.costItems, [])
  assert.deepEqual(outsider.claims, [])
  assert.deepEqual(outsider.proposals, [])
  assert.deepEqual(outsider.cashAccounts.map((a) => a.id), ['cash-other'])
})
