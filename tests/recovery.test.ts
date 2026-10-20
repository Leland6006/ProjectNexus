import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { Pool, type PoolClient } from 'pg'
import { AUTH_SCHEMA } from '../server/auth.ts'
import { businessRequest } from '../server/business.ts'
import { BUSINESS_SCHEMA, BUSINESS_TABLES } from '../server/businessSchema.ts'
import { migrate } from '../server/migrations.ts'
import { PARTNER_SCHEMA } from '../server/partnerSchema.ts'
import { PARTNER_MESSAGE_SCHEMA } from '../server/partnerMessageSchema.ts'
import { HttpError, tenancyRequest, type Principal } from '../server/tenancy.ts'

// PGlite执行真实SQL，但单连接WASM的数据目录备份不等同于独立PostgreSQL/pg_dump恢复。
function adapt(db: { query: PGlite['query'] }): PoolClient {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      const result = await db.query(sql, values)
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
    }
  } as unknown as PoolClient
}

async function migratePGlite(db: PGlite) {
  const initial = `${await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8')}\n${AUTH_SCHEMA}`
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      // WASM只有一个后端会话；网络PostgreSQL测试保留真实锁。
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (
        sql === initial ||
        sql === PARTNER_SCHEMA ||
        sql === BUSINESS_SCHEMA ||
        sql === PARTNER_MESSAGE_SCHEMA
      ) {
        await db.exec(sql)
        return { rows: [] }
      }
      return db.query(sql, values)
    },
    release() {}
  }
  await migrate({ connect: async () => client } as unknown as Pool)
}

type Transaction = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>

function api(transaction: Transaction) {
  return {
    tenancy: <T = Record<string, unknown>>(
      p: Principal,
      method: string,
      path: string,
      body: unknown = {}
    ) => transaction((client) => tenancyRequest(client, p, method, path, body)) as Promise<T>,
    business: async (p: Principal, method = 'getState', ...args: unknown[]) => {
      const result = await transaction((client) => businessRequest(client, p, { method, args }))
      if (!result.ok) assert.fail(`${result.code}: ${result.message}`)
      return result.state
    }
  }
}

async function accounts(client: PoolClient) {
  const people: Principal[] = []
  for (const suffix of ['a', 'b', 'c']) {
    const userId = randomUUID()
    const sessionId = randomUUID()
    const email = `recovery-${suffix}@example.test`
    const name = `恢复验证用户${suffix}`
    await client.query('INSERT INTO identities(id,oidc_sub,email,name) VALUES($1,$2,$3,$4)', [
      userId,
      `recovery|${userId}`,
      email,
      name
    ])
    await client.query(
      `INSERT INTO sessions(id,user_id,token_hash,access_cipher,expires_at)
      VALUES($1,$2,$3,'离线测试会话',now()+interval '1 hour')`,
      [sessionId, userId, randomUUID()]
    )
    people.push({ userId, email, name, sessionId, actingOrgId: null })
  }
  return people as [Principal, Principal, Principal]
}

const transactionInput = (counterpartyOrgId: string) => ({
  name: '可恢复的企业间交易',
  type: '采购',
  counterpartyOrgId,
  amount: 12000,
  expectedSignDate: '2026-12-01',
  description: '磁盘重启和备份恢复验证'
})

async function rejectsHttp(request: Promise<unknown>, status: number, code: string) {
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return true
  })
}

async function companies(service: ReturnType<typeof api>, people: Principal[]) {
  for (const [index, p] of people.entries()) {
    const result = await service.tenancy<{ actingOrgId: string }>(p, 'POST', '/companies', {
      name: `恢复验证企业${index + 1}`
    })
    p.actingOrgId = result.actingOrgId
  }
}

async function allTables(db: PGlite) {
  const names = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  )
  const snapshot: Record<string, unknown[]> = {}
  for (const { tablename } of names.rows) {
    const identifier = `"${tablename.replaceAll('"', '""')}"`
    const result = await db.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(t) AS row FROM ${identifier} t`
    )
    snapshot[tablename] = result.rows
      .map(({ row }) => row)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  return snapshot
}

test('PGlite磁盘：企业协作关闭重启、备份导入新库、迁移账本和审计完整且恢复后仍能写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-recovery-'))
  const originalPath = join(root, 'original')
  const restoredPath = join(root, 'restored')
  let db: PGlite | undefined
  try {
    db = new PGlite(originalPath)
    await migratePGlite(db)
    const [alice, bob, charlie] = await accounts(adapt(db))
    const transaction: Transaction = (run) => db!.transaction((tx) => run(adapt(tx)))
    const service = api(transaction)
    await companies(service, [alice, bob, charlie])
    const requested = await service.tenancy<{ relationship: { id: string } }>(
      alice,
      'POST',
      '/partners',
      { orgId: bob.actingOrgId }
    )
    const relationshipId = requested.relationship.id
    await service.tenancy(bob, 'POST', `/partners/${relationshipId}/accept`)
    await service.tenancy(alice, 'POST', `/partners/${relationshipId}/messages`, {
      body: '备份前的伙伴消息'
    })
    const created = await service.business(
      alice,
      'createTransaction',
      transactionInput(bob.actingOrgId!)
    )
    const transactionId = created.transactions[0].id
    await service.business(alice, 'inviteCounterparty', transactionId)
    await service.business(bob, 'acceptInvitation', transactionId)
    const drafted = await service.business(alice, 'createContract', transactionId, '恢复验证合同')
    const contractId = drafted.contracts[0].id
    await service.business(alice, 'shareContract', contractId)
    await service.business(bob, 'sendMessage', transactionId, '备份前的交易消息', 'shared')
    const expectedViews = await Promise.all([alice, bob, charlie].map((p) => service.business(p)))
    const expected = await allTables(db)
    assert.deepEqual(
      expected.schema_migrations.map((row) => (row as { version: string }).version).sort(),
      [
        '001_identity_foundation',
        '002_partner_relationships',
        '003_scoped_business_storage',
        '004_partner_message_integrity'
      ]
    )
    const actions = new Set(expected.audit.map((row) => (row as { action: string }).action))
    for (const action of [
      'company.created',
      'partner.requested',
      'partner.accepted',
      'partner.message_sent',
      'business.createTransaction',
      'business.inviteCounterparty',
      'business.acceptInvitation',
      'business.createContract',
      'business.shareContract',
      'business.sendMessage'
    ])
      assert.ok(actions.has(action), action)

    await db.close()
    db = new PGlite(originalPath)
    await migratePGlite(db)
    assert.deepEqual(await allTables(db), expected, '磁盘重启和迁移重放必须保留所有行与账本')
    assert.deepEqual(
      await Promise.all([alice, bob, charlie].map((p) => service.business(p))),
      expectedViews
    )
    const archive = await db.dumpDataDir('gzip')
    const backupPath = join(root, 'backup.tar.gz')
    await writeFile(backupPath, new Uint8Array(await archive.arrayBuffer()))
    assert.ok((await readFile(backupPath)).byteLength > 0)
    await db.close()
    db = new PGlite({ dataDir: restoredPath, loadDataDir: new Blob([await readFile(backupPath)]) })
    await migratePGlite(db)
    await migratePGlite(db)
    assert.deepEqual(
      await allTables(db),
      expected,
      '新目录备份恢复及两次迁移重放不能修改账本或任何数据'
    )
    assert.deepEqual(
      await Promise.all([alice, bob, charlie].map((p) => service.business(p))),
      expectedViews
    )

    const partnerInbox = await service.tenancy<{ messages: { body: string }[] }>(
      bob,
      'GET',
      `/partners/${relationshipId}/messages`
    )
    assert.ok(partnerInbox.messages.some((message) => message.body === '备份前的伙伴消息'))
    const outsider = await service.business(charlie)
    for (const key of ['transactions', 'contracts', 'messages', 'activities'] as const)
      assert.deepEqual(outsider[key], [])
    assert.deepEqual(
      outsider.organizations.map((org) => org.id),
      [charlie.actingOrgId]
    )
    assert.deepEqual(
      outsider.users.map((user) => user.id),
      [charlie.userId]
    )
    for (const p of [alice, bob]) {
      const view = await service.business(p)
      assert.deepEqual(
        new Set(view.organizations.map((org) => org.id)),
        new Set([alice.actingOrgId, bob.actingOrgId])
      )
      assert.equal(
        view.users.some((user) => user.id === charlie.userId),
        false
      )
      assert.equal(view.contracts[0].id, contractId)
    }
    assert.equal(
      (
        await db.query<{ legacy: string | null }>(
          "SELECT to_regclass('public.business_state')::text AS legacy"
        )
      ).rows[0].legacy,
      null
    )
    for (const name of Object.values(BUSINESS_TABLES)) {
      const stored: { rows: { payload: Record<string, unknown> }[] } = await db.query(
        `SELECT payload FROM ${name}`
      )
      for (const { payload } of stored.rows) {
        for (const key of ['users', 'organizations', 'identities', 'memberships', 'sessions'])
          assert.equal(key in payload, false, `${name}.${key}`)
        for (const p of [alice, bob, charlie])
          assert.equal(JSON.stringify(payload).includes(p.email), false)
      }
    }
    await rejectsHttp(
      service.tenancy(charlie, 'GET', `/partners/${relationshipId}/messages`),
      404,
      'NOT_FOUND'
    )
    await rejectsHttp(
      service.tenancy(charlie, 'POST', `/partners/${relationshipId}/messages`, {
        body: '第三方注入'
      }),
      404,
      'NOT_FOUND'
    )
    await rejectsHttp(
      service.business(charlie, 'updateTransaction', transactionId, { name: '第三方篡改' }),
      404,
      'NOT_FOUND'
    )
    await rejectsHttp(service.business(charlie, 'shareContract', contractId), 404, 'NOT_FOUND')
    assert.deepEqual(
      await allTables(db),
      expected,
      '越权拒绝和业务读取不能写入业务、审计或迁移账本'
    )

    await service.tenancy(bob, 'POST', `/partners/${relationshipId}/messages`, {
      body: '恢复后的伙伴消息'
    })
    const continued = await service.business(
      bob,
      'sendMessage',
      transactionId,
      '恢复后的交易消息',
      'shared'
    )
    assert.ok(continued.messages.some((message) => message.body === '恢复后的交易消息'))
    const afterWrite = await allTables(db)
    assert.equal(afterWrite.audit.length, expected.audit.length + 2)
    await db.close()
    db = new PGlite(restoredPath)
    await migratePGlite(db)
    assert.deepEqual(await allTables(db), afterWrite, '恢复后的新写入必须再次落盘')
    assert.ok(
      (await service.business(alice)).messages.some(
        (message) => message.body === '恢复后的交易消息'
      )
    )
    await db.close()
    db = new PGlite(originalPath)
    assert.deepEqual(await allTables(db), expected, '恢复目录中的后续写入不能影响原始数据目录')
  } finally {
    try {
      if (db && !db.closed) await db.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

const postgresUrl = process.env.POSTGRES_TEST_URL

test(
  '独立PostgreSQL（opt-in）：两个Pool竞争伙伴申请与同基线合同草稿，仅一个成功',
  {
    skip: postgresUrl
      ? false
      : '未配置POSTGRES_TEST_URL；未执行独立PostgreSQL、多连接竞争或pg_dump恢复',
    timeout: 60000
  },
  async () => {
    const schema = `nexus_recovery_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({
      connectionString: postgresUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 15000
    })
    const options = `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000`
    const first = new Pool({
      connectionString: postgresUrl,
      options,
      max: 1,
      connectionTimeoutMillis: 5000
    })
    const second = new Pool({
      connectionString: postgresUrl,
      options,
      max: 1,
      connectionTimeoutMillis: 5000
    })
    let schemaCreated = false
    const transactionFor =
      (pool: Pool): Transaction =>
      async (run) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await run(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      }
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      schemaCreated = true
      for (const pool of [first, second]) {
        const scope = await pool.query(
          "SELECT current_schema() AS schema,current_setting('search_path') AS path"
        )
        assert.equal(scope.rows[0].schema, schema, '连接必须使用本次创建的隔离schema')
        assert.equal(scope.rows[0].path, schema, '不允许URL选项覆盖隔离search_path或回退到public')
      }
      // 仅在本次随机schema执行真实建表SQL，不修改public或已有迁移账本。
      await first.query('BEGIN')
      try {
        await first.query(
          `${await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8')}\n${AUTH_SCHEMA}\n${PARTNER_SCHEMA}\n${BUSINESS_SCHEMA}\n${PARTNER_MESSAGE_SCHEMA}`
        )
        await first.query('COMMIT')
      } catch (error) {
        await first.query('ROLLBACK')
        throw error
      }
      const [alice, bob, charlie] = await transactionFor(first)(accounts)
      const serviceA = api(transactionFor(first))
      const serviceB = api(transactionFor(second))
      await companies(serviceA, [alice, bob, charlie])
      const pids = await Promise.all([
        first.query('SELECT pg_backend_pid() AS pid'),
        second.query('SELECT pg_backend_pid() AS pid')
      ])
      assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid)
      const requests = await Promise.allSettled([
        serviceA.tenancy<{ relationship: { id: string; requesterOrgId: string } }>(
          alice,
          'POST',
          '/partners',
          { orgId: bob.actingOrgId }
        ),
        serviceB.tenancy<{ relationship: { id: string; requesterOrgId: string } }>(
          bob,
          'POST',
          '/partners',
          { orgId: alice.actingOrgId }
        )
      ])
      assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1)
      const rejected = requests.find(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult
      assert.ok(rejected.reason instanceof HttpError)
      assert.equal(rejected.reason.code, 'PARTNER_EXISTS')
      const successful = requests.find(
        (result) => result.status === 'fulfilled'
      ) as PromiseFulfilledResult<{ relationship: { id: string; requesterOrgId: string } }>
      const relationship = successful.value.relationship
      const recipient = relationship.requesterOrgId === alice.actingOrgId ? bob : alice
      await serviceA.tenancy(recipient, 'POST', `/partners/${relationship.id}/accept`)
      assert.equal(
        (
          await first.query(
            "SELECT count(*)::integer AS count FROM partner_relationships WHERE status='accepted'"
          )
        ).rows[0].count,
        1
      )
      assert.equal(
        (
          await first.query(
            "SELECT count(*)::integer AS count FROM audit WHERE action='partner.requested'"
          )
        ).rows[0].count,
        1
      )
      const created = await serviceA.business(
        alice,
        'createTransaction',
        transactionInput(bob.actingOrgId!)
      )
      const transactionId = created.transactions[0].id
      await serviceA.business(alice, 'inviteCounterparty', transactionId)
      await serviceB.business(bob, 'acceptInvitation', transactionId)
      const drafted = await serviceA.business(
        alice,
        'createContract',
        transactionId,
        '多连接草稿竞争合同'
      )
      const contractId = drafted.contracts[0].id
      await serviceA.business(alice, 'shareContract', contractId)
      const base = structuredClone(drafted.contracts[0].clauses)
      const left = structuredClone(base)
      const right = structuredClone(base)
      left[0].body = '<p>连接甲修改条款</p>'
      right[0].body = '<p>连接乙修改条款</p>'
      const before = (
        await first.query(
          "SELECT count(*)::integer AS count FROM audit WHERE action='business.updateClauses'"
        )
      ).rows[0].count
      const writes = await Promise.allSettled([
        serviceA.business(alice, 'updateClauses', contractId, left, base),
        serviceB.business(alice, 'updateClauses', contractId, right, base)
      ])
      assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1)
      const conflict = writes.find(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult
      assert.ok(conflict.reason instanceof HttpError)
      assert.equal(conflict.reason.status, 409)
      assert.equal(conflict.reason.code, 'CONFLICT')
      assert.equal(
        (
          await first.query(
            "SELECT count(*)::integer AS count FROM audit WHERE action='business.updateClauses'"
          )
        ).rows[0].count,
        before + 1
      )
      const winner = writes[0].status === 'fulfilled' ? left : right
      assert.deepEqual((await serviceB.business(bob)).contracts[0].clauses, winner)
      await rejectsHttp(
        serviceB.business(charlie, 'updateClauses', contractId, base, winner),
        404,
        'NOT_FOUND'
      )
    } finally {
      await Promise.all([first.end(), second.end()])
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await admin.end()
      }
    }
  }
)
