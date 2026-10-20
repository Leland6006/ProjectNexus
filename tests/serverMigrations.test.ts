import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AUTH_SCHEMA } from '../server/auth.ts'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { migrate } from '../server/migrations.ts'
import { PARTNER_SCHEMA } from '../server/partnerSchema.ts'
import { PARTNER_MESSAGE_SCHEMA } from '../server/partnerMessageSchema.ts'
import { emptyBusinessDatabase, persistedBusinessState } from '../server/business.ts'

function poolFor(db: PGlite): Pool {
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      // PGlite 无多后端会话；advisory lock 竞争需由网络 PostgreSQL 验证。
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (!values && (sql.includes(';') || sql.trimStart().startsWith('CREATE TABLE'))) { await db.exec(sql); return { rows: [] } }
      return db.query(sql, values)
    },
    release() {}
  }
  return { connect: async () => client } as unknown as Pool
}

test('server migration: empty database bootstraps once, preserves records and verifies checksum', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const pool = poolFor(db)
  await migrate(pool)
  await db.query("INSERT INTO identities(id,oidc_sub,email,name) VALUES('u','issuer|u','u@example.test','测试用户')")
  await migrate(pool)
  assert.equal((await db.query('SELECT id FROM identities')).rows.length, 1)
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows, [
    { version: '001_identity_foundation' }, { version: '002_partner_relationships' }, { version: '003_scoped_business_storage' }, { version: '004_partner_message_integrity' }
  ])
  await db.query("INSERT INTO organizations(id,name,short_name) VALUES('a','虚构甲','甲'),('b','虚构乙','乙')")
  await db.query("INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id) VALUES('partner','a','b')")
  await db.query("INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('message','partner','u','a','虚构迁移保留消息')")
  await migrate(pool)
  assert.equal((await db.query('SELECT id FROM partner_relationships')).rows.length, 1)
  assert.deepEqual((await db.query('SELECT body FROM partner_messages')).rows, [{ body: '虚构迁移保留消息' }])
  await db.query("UPDATE schema_migrations SET checksum='modified'")
  await assert.rejects(migrate(pool), /checksum mismatch/)
  assert.equal((await db.query('SELECT id FROM identities')).rows.length, 1)
})

async function recorded001(db: PGlite): Promise<void> {
  const sql = `${await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8')}\n${AUTH_SCHEMA}`
  await db.exec(sql)
  await db.exec('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())')
  await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', ['001_identity_foundation', createHash('sha256').update(sql).digest('hex')])
  await db.query("INSERT INTO identities(id,oidc_sub,email,name) VALUES('old','issuer|old','old@example.test','保留用户')")
}

test('server migration: upgrades recorded 001 into relational storage and preserves business records', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await recorded001(db)
  await db.query("INSERT INTO organizations(id,name,short_name) VALUES('a','虚构甲','甲'),('b','虚构乙','乙')")
  const snapshot = {
    ...persistedBusinessState(emptyBusinessDatabase()),
    users: [{ id: 'stale-user' }], organizations: [{ id: 'stale-org' }]
  }
  snapshot.transactions.push({
    id: 'legacy-tx', name: '虚构历史交易', type: '采购', initiatorOrgId: 'a', counterpartyOrgId: 'b',
    amount: 12, currency: 'CNY', expectedSignDate: '2026-12-01', description: '', status: 'draft',
    counterpartyStatus: 'none', counselGrants: [], createdBy: 'old', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z'
  })
  snapshot.messages.push({ id: 'legacy-message', transactionId: 'legacy-tx', authorId: 'old', orgId: 'a', body: '虚构历史正文', visibility: 'internal', createdAt: '2026-10-20T00:00:00Z' })
  await db.query('UPDATE business_state SET payload=$1,revision=7', [JSON.stringify(snapshot)])
  await migrate(poolFor(db))
  await migrate(poolFor(db))
  assert.deepEqual((await db.query('SELECT id FROM identities')).rows, [{ id: 'old' }])
  assert.deepEqual((await db.query('SELECT id FROM organizations ORDER BY id')).rows, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual((await db.query('SELECT payload FROM business_transactions')).rows, [{ payload: snapshot.transactions[0] }])
  assert.deepEqual((await db.query('SELECT payload FROM business_messages')).rows, [{ payload: snapshot.messages[0] }])
  assert.equal((await db.query('SELECT version FROM schema_migrations')).rows.length, 4)
  assert.equal((await db.query('SELECT id FROM partner_relationships')).rows.length, 0)
  assert.equal((await db.query<{ table_name: string | null }>("SELECT to_regclass('business_state')::text AS table_name")).rows[0].table_name, null)
})

test('服务端迁移：已记录002升级保留伙伴关系和独立企业消息', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await recorded001(db)
  await db.exec(PARTNER_SCHEMA)
  await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', ['002_partner_relationships', createHash('sha256').update(PARTNER_SCHEMA).digest('hex')])
  await db.query("INSERT INTO organizations(id,name,short_name) VALUES('a','虚构甲','甲'),('b','虚构乙','乙')")
  await db.query("INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id,status,revision) VALUES('existing-partner','a','b','accepted',2)")
  await db.query("INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('existing-message','existing-partner','old','a','虚构002历史消息')")
  await migrate(poolFor(db))
  await migrate(poolFor(db))
  assert.deepEqual((await db.query('SELECT id,status,revision FROM partner_relationships')).rows, [{ id: 'existing-partner', status: 'accepted', revision: 2 }])
  assert.deepEqual((await db.query('SELECT id,body FROM partner_messages')).rows, [{ id: 'existing-message', body: '虚构002历史消息' }])
  assert.equal((await db.query('SELECT version FROM schema_migrations')).rows.length, 4)
  assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('business_state')::text AS name")).rows[0].name, null)
  await assert.rejects(db.query("INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('outsider-message','existing-partner','old','outsider','bad')"),
    (error: unknown) => (error as { code: string }).code === '23514')
  await assert.rejects(db.query("UPDATE partner_messages SET org_id='outsider' WHERE id='existing-message'"),
    (error: unknown) => (error as { code: string }).code === '23514')
  await assert.rejects(db.query("UPDATE partner_relationships SET requester_org_id='outsider' WHERE id='existing-partner'"),
    (error: unknown) => (error as { code: string }).code === '23514')
  assert.deepEqual((await db.query('SELECT id,body FROM partner_messages')).rows, [{ id: 'existing-message', body: '虚构002历史消息' }])
  assert.equal((await db.query('SELECT version FROM schema_migrations')).rows.length, 4)
})

test('server migration: 004 rejects legacy messages whose organization is not a participant', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await recorded001(db)
  await db.exec(PARTNER_SCHEMA)
  await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', ['002_partner_relationships', createHash('sha256').update(PARTNER_SCHEMA).digest('hex')])
  await db.query("INSERT INTO organizations(id,name,short_name) VALUES('a','甲','甲'),('b','乙','乙'),('c','丙','丙')")
  await db.query("INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id,status) VALUES('legacy-partner','a','b','accepted')")
  await db.query("INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body) VALUES('legacy-invalid','legacy-partner','old','c','保留检查')")
  await assert.rejects(migrate(poolFor(db)), (error: unknown) => (error as { code: string }).code === '23514')
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
    [{ version: '001_identity_foundation' }, { version: '002_partner_relationships' }])
  assert.deepEqual((await db.query('SELECT id,org_id FROM partner_messages')).rows, [{ id: 'legacy-invalid', org_id: 'c' }])
  assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('business_transactions')::text AS name")).rows[0].name, null)
})

test('server migration: future snapshot rejects 003 and rolls back earlier work in the same transaction', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await recorded001(db)
  const snapshot = { ...persistedBusinessState(emptyBusinessDatabase()), schemaVersion: 999 }
  await db.query('UPDATE business_state SET payload=$1,revision=7', [JSON.stringify(snapshot)])
  await assert.rejects(migrate(poolFor(db)), /业务数据版本不受支持/)
  assert.deepEqual((await db.query('SELECT payload,revision::integer AS revision FROM business_state')).rows, [{ payload: snapshot, revision: 7 }])
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations')).rows, [{ version: '001_identity_foundation' }])
  assert.deepEqual((await db.query('SELECT id FROM identities')).rows, [{ id: 'old' }])
  for (const table of ['partner_relationships', 'partner_messages', 'business_transactions', 'business_org_scopes']) {
    assert.equal((await db.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [table])).rows[0].name, null)
  }
})

test('服务端迁移：未知字段、不完整集合和非数组目录均拒绝且保留原始快照', async (t) => {
  const full = persistedBusinessState(emptyBusinessDatabase())
  const invalidSnapshots = [
    { name: '未知字段', payload: { ...full, unknown: [] } },
    { name: '缺少业务集合', payload: { schemaVersion: full.schemaVersion } },
    { name: '非数组业务集合', payload: { ...full, transactions: {} } },
    { name: '非数组用户目录', payload: { ...full, users: {} } },
    { name: '空值企业目录', payload: { ...full, organizations: null } }
  ]
  for (const { name, payload } of invalidSnapshots) {
    await t.test(name, async (subtest) => {
      const db = new PGlite()
      subtest.after(() => db.close())
      await recorded001(db)
      await db.query('UPDATE business_state SET payload=$1,revision=11', [JSON.stringify(payload)])
      await assert.rejects(migrate(poolFor(db)), /业务数据包含未知字段|业务集合格式无效|业务目录格式无效/)
      assert.deepEqual((await db.query('SELECT payload,revision::integer AS revision FROM business_state')).rows, [{ payload, revision: 11 }])
      assert.deepEqual((await db.query('SELECT version FROM schema_migrations')).rows, [{ version: '001_identity_foundation' }])
      assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('business_transactions')::text AS name")).rows[0].name, null)
    })
  }
})

test('server migration: refuses an unversioned existing schema without changing it', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE TABLE identities(id text PRIMARY KEY)')
  await db.query("INSERT INTO identities(id) VALUES('keep-me')")
  await assert.rejects(migrate(poolFor(db)), /Unversioned identity schema/)
  assert.deepEqual((await db.query('SELECT id FROM identities')).rows, [{ id: 'keep-me' }])
  assert.equal((await db.query<{ ledger: string | null }>("SELECT to_regclass('schema_migrations') AS ledger")).rows[0]?.ledger, null)
})

test('server migration: refuses a database newer than the running API', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const pool = poolFor(db)
  await migrate(pool)
  await db.query("INSERT INTO schema_migrations(version,checksum) VALUES('999_future','future')")
  await assert.rejects(migrate(pool), /newer than this API/)
})
