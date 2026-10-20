import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { Pool, PoolClient } from 'pg'
import {
  businessRequest,
  emptyBusinessDatabase,
  persistedBusinessState,
  readBusinessState
} from '../server/business.ts'
import { migrate } from '../server/migrations.ts'
import type { PartnerMessage, PartnerRelationship } from '../server/partners.ts'
import { HttpError, tenancyRequest, type Principal } from '../server/tenancy.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'

// 真实 PostgreSQL WASM 查询；单连接不声称覆盖网络 PostgreSQL 的并发锁竞争。
async function fixture(t: TestContext) {
  const db = new PGlite()
  t.after(() => db.close())
  const migrationClient = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (!values && (sql.includes(';') || sql.trimStart().startsWith('CREATE TABLE'))) {
        await db.exec(sql)
        return { rows: [] }
      }
      return db.query(sql, values)
    },
    release() {}
  }
  await migrate({ connect: async () => migrationClient } as unknown as Pool)
  const people: Principal[] = []
  for (const id of ['a', 'b', 'c']) {
    await db.query('INSERT INTO identities(id,oidc_sub,email,name) VALUES($1,$2,$3,$4)', [
      id,
      `issuer|${id}`,
      `${id}@example.test`,
      `虚构用户${id}`
    ])
    await db.query('INSERT INTO organizations(id,name,short_name) VALUES($1,$2,$3)', [
      `org-${id}`,
      `虚构企业${id}`,
      id
    ])
    await db.query("INSERT INTO memberships(id,user_id,org_id,role) VALUES($1,$2,$3,'owner')", [
      `member-${id}`,
      id,
      `org-${id}`
    ])
    people.push({
      userId: id,
      email: `${id}@example.test`,
      name: `虚构用户${id}`,
      sessionId: `session-${id}`,
      actingOrgId: `org-${id}`
    })
  }
  const [alice, bob, charlie] = people as [Principal, Principal, Principal]
  const transaction = <T>(run: (client: PoolClient) => Promise<T>) =>
    db.transaction((tx) =>
      run({
        query: async (sql: string, args: unknown[] = []) => {
          const result = await tx.query(sql, args)
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
        }
      } as unknown as PoolClient)
    )
  const request = <T = { relationship: PartnerRelationship }>(
    p: Principal,
    method: string,
    path: string,
    body: unknown = {}
  ) => transaction((client) => tenancyRequest(client, p, method, path, body)) as Promise<T>
  const list = async (p: Principal) =>
    (await request<{ partners: PartnerRelationship[] }>(p, 'GET', '/partners')).partners
  const apply = async (p = alice, orgId = bob.actingOrgId!) =>
    (await request(p, 'POST', '/partners', { orgId })).relationship
  const act = async (p: Principal, id: string, action: string) =>
    (await request(p, 'POST', `/partners/${id}/${action}`)).relationship
  const business = async (p: Principal, method = 'getState', ...args: unknown[]) => {
    const result = await transaction((client) => businessRequest(client, p, { method, args }))
    if (!result.ok) assert.fail(`${result.code}: ${result.message}`)
    return result.state
  }
  return { db, alice, bob, charlie, request, list, apply, act, business }
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
  name: '虚构合作交易',
  type: '采购',
  counterpartyOrgId,
  amount: 1000,
  expectedSignDate: '2026-12-01',
  description: ''
})

test('合作：空列表、明确企业ID申请、双方目录投影、收方确认及第三方隔离', async (t) => {
  const { alice, bob, charlie, list, apply, act, request, business } = await fixture(t)
  assert.deepEqual(await list(alice), [])
  assert.deepEqual(
    (await business(alice)).organizations.map((o) => o.id),
    ['org-a']
  )
  await rejectsHttp(list({ ...alice, actingOrgId: null }), 409, 'ACTING_COMPANY_REQUIRED')
  await rejectsHttp(apply(alice, 'org-a'), 400, 'INVALID_INPUT')
  await rejectsHttp(apply(alice, 'does-not-exist'), 404, 'NOT_FOUND')
  await rejectsHttp(
    request(alice, 'POST', '/partners', { orgId: 'org-b', requesterOrgId: 'org-c' }),
    400,
    'INVALID_INPUT'
  )
  const pending = await apply()
  assert.deepEqual(
    Object.keys(pending).sort(),
    ['id', 'requesterOrgId', 'recipientOrgId', 'partner', 'status', 'revision', 'createdAt'].sort()
  )
  assert.equal(pending.requesterOrgId, 'org-a')
  assert.equal(pending.recipientOrgId, 'org-b')
  assert.deepEqual(pending.partner, { id: 'org-b', name: '虚构企业b', shortName: 'b' })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.revision, 1)
  assert.equal(new Date(pending.createdAt).toISOString(), pending.createdAt)
  assert.deepEqual((await list(bob))[0].partner, { id: 'org-a', name: '虚构企业a', shortName: 'a' })
  assert.deepEqual(await list(charlie), [])
  for (const action of ['accept', 'reject', 'withdraw', 'disconnect'])
    await rejectsHttp(act(charlie, pending.id, action), 404, 'NOT_FOUND')
  await rejectsHttp(act(alice, pending.id, 'accept'), 403, 'PERMISSION_DENIED')
  await rejectsHttp(act(alice, pending.id, 'reject'), 403, 'PERMISSION_DENIED')
  await rejectsHttp(act(bob, pending.id, 'withdraw'), 403, 'PERMISSION_DENIED')
  await rejectsHttp(act(alice, pending.id, 'disconnect'), 409, 'PARTNER_UNAVAILABLE')
  await rejectsHttp(
    request(bob, 'POST', `/partners/${pending.id}/accept`, { role: 'owner' }),
    400,
    'INVALID_INPUT'
  )
  const accepted = await act(bob, pending.id, 'accept')
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.revision, 2)
  assert.deepEqual(accepted.partner, { id: 'org-a', name: '虚构企业a', shortName: 'a' })
  assert.deepEqual(
    new Set((await business(alice)).organizations.map((o) => o.id)),
    new Set(['org-a', 'org-b'])
  )
  assert.deepEqual(
    new Set((await business(bob)).organizations.map((o) => o.id)),
    new Set(['org-a', 'org-b'])
  )
  assert.deepEqual(
    (await business(charlie)).organizations.map((o) => o.id),
    ['org-c']
  )
})

test('合作：拒绝、撤回、断开及重试，双向仅一个活跃关系且重复操作不增加审计', async (t) => {
  const { db, alice, bob, apply, act, list } = await fixture(t)
  const first = await apply()
  await rejectsHttp(apply(), 409, 'PARTNER_EXISTS')
  await rejectsHttp(apply(bob, 'org-a'), 409, 'PARTNER_EXISTS')
  const rejected = await act(bob, first.id, 'reject')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.revision, 2)
  await rejectsHttp(act(bob, first.id, 'accept'), 409, 'PARTNER_UNAVAILABLE')
  const second = await apply(bob, 'org-a')
  assert.notEqual(second.id, first.id)
  const withdrawn = await act(bob, second.id, 'withdraw')
  assert.equal(withdrawn.status, 'withdrawn')
  await rejectsHttp(act(bob, second.id, 'withdraw'), 409, 'PARTNER_UNAVAILABLE')
  const third = await apply()
  await act(bob, third.id, 'accept')
  await rejectsHttp(apply(bob, 'org-a'), 409, 'PARTNER_EXISTS')
  const disconnected = await act(alice, third.id, 'disconnect')
  assert.equal(disconnected.status, 'disconnected')
  assert.equal(disconnected.revision, 3)
  await rejectsHttp(act(bob, third.id, 'disconnect'), 409, 'PARTNER_UNAVAILABLE')
  const fourth = await apply(bob, 'org-a')
  await act(alice, fourth.id, 'accept')
  assert.equal((await act(bob, fourth.id, 'disconnect')).status, 'disconnected')
  assert.equal((await list(alice)).length, 4)
  const audits = await db.query<{ action: string; count: number }>(
    "SELECT action,count(*)::integer AS count FROM audit WHERE action LIKE 'partner.%' GROUP BY action"
  )
  assert.deepEqual(Object.fromEntries(audits.rows.map((r) => [r.action, r.count])), {
    'partner.requested': 4,
    'partner.accepted': 2,
    'partner.rejected': 1,
    'partner.withdrawn': 1,
    'partner.disconnected': 2
  })
})

test('合作：SQL双向唯一索引、自申请约束及身份外键兜底', async (t) => {
  const { db, alice, bob, apply, act } = await fixture(t)
  const pending = await apply()
  const insert = (id: string, requester: string, recipient: string, status = 'pending') =>
    db.query(
      'INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id,status) VALUES($1,$2,$3,$4)',
      [id, requester, recipient, status]
    )
  await assert.rejects(
    insert('reverse', 'org-b', 'org-a'),
    (error: unknown) => (error as { code: string }).code === '23505'
  )
  await assert.rejects(
    insert('same', 'org-a', 'org-a'),
    (error: unknown) => (error as { code: string }).code === '23514'
  )
  await assert.rejects(
    insert('missing', 'org-a', 'unknown'),
    (error: unknown) => (error as { code: string }).code === '23503'
  )
  await act(bob, pending.id, 'accept')
  await assert.rejects(
    insert('accepted-reverse', 'org-b', 'org-a', 'accepted'),
    (error: unknown) => (error as { code: string }).code === '23505'
  )
  await act(alice, pending.id, 'disconnect')
  await insert('retry', 'org-b', 'org-a')
  assert.equal((await db.query('SELECT * FROM partner_pairs')).rows.length, 1)
})

test('合作：每次操作重读角色和成员状态，旧Principal降权或撤权立即失效', async (t) => {
  const { db, alice, bob, charlie, apply, act, list } = await fixture(t)
  const pending = await apply()
  const stale = { ...bob }
  for (const role of ['finance', 'legal', 'readonly']) {
    await db.query('UPDATE memberships SET role=$1 WHERE user_id=$2', [role, bob.userId])
    assert.equal((await list(stale)).length, 1)
    await rejectsHttp(act(stale, pending.id, 'accept'), 403, 'PERMISSION_DENIED')
    await rejectsHttp(act(stale, pending.id, 'reject'), 403, 'PERMISSION_DENIED')
    await rejectsHttp(apply(stale, charlie.actingOrgId!), 403, 'PERMISSION_DENIED')
  }
  await db.query("UPDATE memberships SET role='business' WHERE user_id=$1", [bob.userId])
  await act(stale, pending.id, 'accept')
  await db.query("UPDATE memberships SET role='admin' WHERE user_id=$1", [bob.userId])
  await act(stale, pending.id, 'disconnect')
  await db.query("UPDATE memberships SET status='removed' WHERE user_id=$1", [bob.userId])
  await rejectsHttp(list(stale), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(apply(stale, alice.actingOrgId!), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(act(stale, pending.id, 'accept'), 403, 'MEMBERSHIP_REQUIRED')
  await db.query("UPDATE memberships SET status='active' WHERE user_id=$1", [bob.userId])
  await db.query("UPDATE identities SET status='disabled' WHERE id=$1", [bob.userId])
  await rejectsHttp(list(stale), 403, 'MEMBERSHIP_REQUIRED')
})

test('合作：交易需要已确认伙伴，断开禁止新交易并保留已共享历史权限', async (t) => {
  const { db, alice, bob, charlie, business, apply, act } = await fixture(t)
  const create = (target = 'org-b') =>
    business(alice, 'createTransaction', transactionInput(target))
  await rejectsHttp(create(), 409, 'PARTNER_REQUIRED')
  await rejectsHttp(create('org-c'), 409, 'PARTNER_REQUIRED')
  const pending = await apply()
  await rejectsHttp(create(), 409, 'PARTNER_REQUIRED')
  await act(bob, pending.id, 'accept')
  const txId = (await create()).transactions[0].id
  await business(alice, 'inviteCounterparty', txId)
  assert.equal((await business(bob)).transactions[0].id, txId)
  await act(bob, pending.id, 'disconnect')
  await rejectsHttp(create(), 409, 'PARTNER_REQUIRED')
  assert.equal((await business(alice)).transactions[0].id, txId)
  assert.equal((await business(bob)).transactions[0].id, txId)
  await business(bob, 'sendMessage', txId, '虚构历史交易消息', 'shared')
  assert.equal((await business(alice)).messages.length, 1)
  assert.deepEqual((await business(charlie)).transactions, [])
  assert.deepEqual(
    new Set((await business(alice)).organizations.map((o) => o.id)),
    new Set(['org-a', 'org-b'])
  )
  const storedTransactions = (
    await db.query<{ id: string; initiator_org_id: string; counterparty_org_id: string }>(
      'SELECT id,initiator_org_id,counterparty_org_id FROM business_transactions'
    )
  ).rows
  assert.deepEqual(storedTransactions, [
    { id: txId, initiator_org_id: 'org-a', counterparty_org_id: 'org-b' }
  ])
  const storedMessages = (
    await db.query<{ payload: { transactionId: string; body: string } }>(
      'SELECT payload FROM business_messages'
    )
  ).rows
  assert.equal(storedMessages.length, 1)
  assert.equal(storedMessages[0].payload.transactionId, txId)
  assert.equal(storedMessages[0].payload.body, '虚构历史交易消息')
  assert.equal(
    (await db.query<{ name: string | null }>("SELECT to_regclass('business_state')::text AS name"))
      .rows[0].name,
    null
  )
})

test('企业消息：双方独立消息及断开重连历史，第三方隔离且审计不含正文', async (t) => {
  const { db, alice, bob, charlie, request, apply, act } = await fixture(t)
  const pending = await apply()
  const path = `/partners/${pending.id}/messages`
  const read = (p: Principal, target = path) =>
    request<{ messages: PartnerMessage[] }>(p, 'GET', target)
  const send = (p: Principal, body: unknown, target = path) =>
    request<{ message: PartnerMessage }>(p, 'POST', target, body)
  await rejectsHttp(read(alice), 409, 'PARTNER_UNAVAILABLE')
  await rejectsHttp(send(alice, { body: '尚未确认' }), 409, 'PARTNER_UNAVAILABLE')
  await rejectsHttp(read(charlie), 404, 'NOT_FOUND')
  await rejectsHttp(send(charlie, { body: '第三方' }), 404, 'NOT_FOUND')
  await act(bob, pending.id, 'accept')
  assert.deepEqual((await read(alice)).messages, [])
  const first = (await send(alice, { body: '  虚构独立企业消息  ' })).message
  assert.deepEqual(
    Object.keys(first).sort(),
    ['id', 'relationshipId', 'authorId', 'orgId', 'body', 'createdAt'].sort()
  )
  assert.equal(first.body, '虚构独立企业消息')
  assert.equal(first.relationshipId, pending.id)
  assert.equal(first.authorId, alice.userId)
  assert.equal(first.orgId, alice.actingOrgId)
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt)
  const second = (await send(bob, { body: '收方回复' })).message
  assert.deepEqual(
    (await read(alice)).messages.map((m) => m.id),
    [first.id, second.id]
  )
  assert.deepEqual(
    (await read(bob)).messages.map((m) => m.body),
    ['虚构独立企业消息', '收方回复']
  )
  await act(alice, pending.id, 'disconnect')
  assert.equal((await read(bob)).messages.length, 2)
  await rejectsHttp(send(alice, { body: '断开后新消息' }), 409, 'PARTNER_UNAVAILABLE')
  const reconnected = await apply(bob, 'org-a')
  await act(alice, reconnected.id, 'accept')
  const nextPath = `/partners/${reconnected.id}/messages`
  assert.deepEqual((await read(alice, nextPath)).messages, [])
  await send(bob, { body: '重新合作消息' }, nextPath)
  assert.equal((await read(alice)).messages.length, 2)
  assert.equal((await read(alice, nextPath)).messages.length, 1)
  await rejectsHttp(read(charlie, nextPath), 404, 'NOT_FOUND')
  const audits = (
    await db.query<{ target_id: string; detail: Record<string, unknown> }>(
      "SELECT target_id,detail FROM audit WHERE action='partner.message_sent'"
    )
  ).rows
  const messageIds = (await db.query<{ id: string }>('SELECT id FROM partner_messages')).rows.map(
    (row) => row.id
  )
  assert.equal(audits.length, 3)
  assert.equal(messageIds.length, 3)
  assert.deepEqual(new Set(audits.map((row) => row.target_id)), new Set(messageIds))
  assert.ok(audits.every((row) => Object.keys(row.detail).join() === 'relationshipId'))
  assert.equal(JSON.stringify(audits).includes(first.body), false)
  assert.equal(JSON.stringify((await read(alice)).messages).includes(alice.email), false)
})

test('企业消息：动态角色、撤权、正文限制及SQL约束', async (t) => {
  const { db, alice, bob, request, apply, act } = await fixture(t)
  const pending = await apply()
  await act(bob, pending.id, 'accept')
  const path = `/partners/${pending.id}/messages`
  const stale = { ...bob }
  for (const role of ['owner', 'admin', 'business', 'finance', 'legal']) {
    await db.query('UPDATE memberships SET role=$1 WHERE user_id=$2', [role, bob.userId])
    await request(stale, 'POST', path, { body: `${role}企业消息` })
  }
  await db.query("UPDATE memberships SET role='readonly' WHERE user_id=$1", [bob.userId])
  assert.equal(
    (await request<{ messages: PartnerMessage[] }>(stale, 'GET', path)).messages.length,
    5
  )
  await rejectsHttp(request(stale, 'POST', path, { body: '只读越权' }), 403, 'PERMISSION_DENIED')
  await db.query("UPDATE memberships SET status='removed' WHERE user_id=$1", [bob.userId])
  await rejectsHttp(request(stale, 'GET', path), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(
    request(stale, 'POST', path, { body: '移除后写入' }),
    403,
    'MEMBERSHIP_REQUIRED'
  )
  await db.query("UPDATE memberships SET status='active',role='business' WHERE user_id=$1", [
    bob.userId
  ])
  await db.query("UPDATE identities SET status='disabled' WHERE id=$1", [bob.userId])
  await rejectsHttp(request(stale, 'GET', path), 403, 'MEMBERSHIP_REQUIRED')
  await rejectsHttp(
    request(stale, 'POST', path, { body: '身份停用后写入' }),
    403,
    'MEMBERSHIP_REQUIRED'
  )
  for (const body of [
    {},
    { body: '' },
    { body: '   ' },
    { body: 12 },
    { body: '文'.repeat(10001) },
    { body: '正常', authorId: 'b' }
  ]) {
    await rejectsHttp(request(alice, 'POST', path, body), 400, 'INVALID_INPUT')
  }
  await request(alice, 'POST', path, { body: '文'.repeat(10000) })
  await request(alice, 'POST', path, { body: String.fromCodePoint(0x20000).repeat(10000) })
  await assert.rejects(
    db.query(
      'INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES($1,$2,$3,$4,$5)',
      ['invalid-body', pending.id, alice.userId, alice.actingOrgId, '']
    ),
    (error: unknown) => (error as { code: string }).code === '23514'
  )
  await assert.rejects(
    db.query(
      'INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES($1,$2,$3,$4,$5)',
      ['oversized-body', pending.id, alice.userId, alice.actingOrgId, ' '.repeat(10000) + '文']
    ),
    (error: unknown) => (error as { code: string }).code === '23514'
  )
  await assert.rejects(
    db.query(
      'INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES($1,$2,$3,$4,$5)',
      ['invalid-relation', 'missing', alice.userId, alice.actingOrgId, '正文']
    ),
    (error: unknown) => (error as { code: string }).code === '23503'
  )
})

test('004：数据库拒绝第三方消息及归属变更，并保持关系双方不可变', async (t) => {
  const { db, alice, bob, charlie, apply, act } = await fixture(t)
  const relationship = await apply()
  await act(bob, relationship.id, 'accept')
  const insert = (id: string, orgId: string) =>
    db.query(
      'INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES($1,$2,$3,$4,$5)',
      [id, relationship.id, alice.userId, orgId, '完整性验证消息']
    )
  const checkViolation = (error: unknown) => (error as { code: string }).code === '23514'
  await insert('valid-participant', alice.actingOrgId!)
  await assert.rejects(insert('outsider-participant', charlie.actingOrgId!), checkViolation)
  await assert.rejects(
    db.query("UPDATE partner_messages SET org_id=$1 WHERE id='valid-participant'", [
      charlie.actingOrgId
    ]),
    checkViolation
  )
  await db.query(
    "INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id) VALUES('other-pair',$1,$2)",
    [bob.actingOrgId, charlie.actingOrgId]
  )
  await assert.rejects(
    db.query(
      "UPDATE partner_messages SET relationship_id='other-pair' WHERE id='valid-participant'"
    ),
    checkViolation
  )
  for (const column of ['requester_org_id', 'recipient_org_id']) {
    await assert.rejects(
      db.query(`UPDATE partner_relationships SET ${column}=$1 WHERE id=$2`, [
        charlie.actingOrgId,
        relationship.id
      ]),
      checkViolation
    )
  }
  // Unchanged participant columns and normal lifecycle transitions stay valid.
  await db.query(
    'UPDATE partner_relationships SET requester_org_id=requester_org_id,recipient_org_id=recipient_org_id WHERE id=$1',
    [relationship.id]
  )
  await act(alice, relationship.id, 'disconnect')
  assert.deepEqual(
    (await db.query('SELECT id,org_id,relationship_id FROM partner_messages')).rows,
    [{ id: 'valid-participant', org_id: alice.actingOrgId, relationship_id: relationship.id }]
  )
})

test('企业消息：审计写入失败时正文与审计在同一事务回滚', async (t) => {
  const { db, alice, bob, request, apply, act } = await fixture(t)
  const accepted = await apply()
  await act(bob, accepted.id, 'accept')
  const auditCount = (await db.query('SELECT id FROM audit')).rows.length
  await db.exec(`CREATE FUNCTION reject_partner_message_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='partner.message_sent' THEN RAISE EXCEPTION '虚构审计失败'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_partner_message_audit BEFORE INSERT ON audit
      FOR EACH ROW EXECUTE FUNCTION reject_partner_message_audit();`)
  await assert.rejects(
    request(alice, 'POST', `/partners/${accepted.id}/messages`, { body: '应回滚的虚构消息' }),
    /虚构审计失败/
  )
  assert.deepEqual((await db.query('SELECT id FROM partner_messages')).rows, [])
  assert.equal((await db.query('SELECT id FROM audit')).rows.length, auditCount)
})

test('企业消息：最近100条按时间和编号确定排序，pending异常植入不可读', async (t) => {
  const { db, alice, bob, request, apply, act } = await fixture(t)
  const pending = await apply()
  const path = `/partners/${pending.id}/messages`
  await db.query(
    `INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body,created_at)
    SELECT 'msg-'||lpad(n::text,3,'0'),$1,$2,$3,'虚构消息'||n::text,'2026-10-20T00:00:00Z'::timestamptz
    FROM generate_series(1,105) AS n`,
    [pending.id, alice.userId, alice.actingOrgId]
  )
  await rejectsHttp(request(alice, 'GET', path), 409, 'PARTNER_UNAVAILABLE')
  await act(bob, pending.id, 'accept')
  const messages = (await request<{ messages: PartnerMessage[] }>(bob, 'GET', path)).messages
  assert.equal(messages.length, 100)
  assert.equal(messages[0].id, 'msg-006')
  assert.equal(messages[99].id, 'msg-105')
  assert.deepEqual(
    messages.map((m) => m.id),
    [...messages.map((m) => m.id)].sort()
  )
})

test('业务快照：仅明确空bootstrap和完整当前版本，拒绝未知版本/字段/不完整集合', () => {
  assert.deepEqual(readBusinessState({}), emptyBusinessDatabase())
  const payload = persistedBusinessState(emptyBusinessDatabase())
  assert.deepEqual(readBusinessState(payload), emptyBusinessDatabase())
  assert.deepEqual(
    readBusinessState({
      ...payload,
      users: [{ id: 'stale-user' }],
      organizations: [{ id: 'stale-org' }]
    }),
    emptyBusinessDatabase()
  )
  for (const invalid of [
    null,
    [],
    'bad',
    { schemaVersion: 999 },
    { ...payload, schemaVersion: 1 },
    { ...payload, schemaVersion: undefined },
    { ...payload, schemaVersion: '2' },
    { ...payload, unknown: [] },
    { ...payload, transactions: {} },
    { ...payload, users: {} },
    { ...payload, organizations: null },
    { schemaVersion: CURRENT_SCHEMA_VERSION }
  ]) {
    assert.throws(() => readBusinessState(invalid))
  }
})
