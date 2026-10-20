import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { PoolClient } from 'pg'
import { BUSINESS_SCHEMA, BUSINESS_TABLES } from '../server/businessSchema.ts'
import {
  emptyBusinessDatabase,
  persistedBusinessState,
  tenantChangeFingerprint
} from '../server/business.ts'
import {
  loadBusinessDatabase,
  persistBusinessDatabase,
  snapshotBusiness,
  validateBusinessDatabase
} from '../server/businessStorage.ts'
import { createSeedDatabase } from '../src/shared/seed.ts'
import type { Database } from '../src/shared/types.ts'

function adapt(
  db: Pick<PGlite, 'query'>,
  queries?: { sql: string; values: unknown[] }[]
): PoolClient {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      queries?.push({ sql, values })
      const result = await db.query(sql, values)
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
    }
  } as unknown as PoolClient
}

async function fixture(t: TestContext, snapshot: Database = createSeedDatabase()) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'))
  for (const org of snapshot.organizations)
    await db.query('INSERT INTO organizations(id,name,short_name,kind) VALUES($1,$2,$3,$4)', [
      org.id,
      org.name,
      org.shortName,
      org.kind
    ])
  for (const [index, user] of snapshot.users.entries())
    await db.query('INSERT INTO identities(id,oidc_sub,email,name) VALUES($1,$2,$3,$4)', [
      user.id,
      `subject-${index}`,
      `user${index}@example.test`,
      user.name
    ])
  await db.query('UPDATE business_state SET payload=$1::jsonb,revision=9', [
    JSON.stringify(persistedBusinessState(snapshot))
  ])
  const migrate = () => db.transaction(async (tx) => tx.exec(BUSINESS_SCHEMA))
  return { db, snapshot, migrate }
}

test('003：完整迁移各业务集合且删除旧源，所有payload逐项保留', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  validateBusinessDatabase(snapshot)
  await migrate()
  for (const [key, table] of Object.entries(BUSINESS_TABLES)) {
    const records = await db.query<{ payload: { id: string } }>(
      `SELECT payload FROM ${table} ORDER BY id`
    )
    const original = snapshot[key as keyof typeof BUSINESS_TABLES]
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(
      records.rows.map((row) => row.payload).sort((a, b) => a.id.localeCompare(b.id)),
      original
    )
  }
  assert.equal(
    (await db.query<{ name: string | null }>("SELECT to_regclass('business_state') AS name"))
      .rows[0].name,
    null
  )
  assert.ok((await db.query('SELECT * FROM business_proposal_claims')).rows.length)
})

test('003：未知版本、缺失集合、悬空引用、跨组织实体及版本空洞全部回滚原快照', async (t) => {
  const mutations: [string, (db: Database) => void][] = [
    [
      '未知版本',
      (db) => {
        db.schemaVersion = 999
      }
    ],
    [
      '缺失集合',
      (db) => {
        delete (db as Partial<Database>).messages
      }
    ],
    [
      '悬空作者',
      (db) => {
        db.transactions[0].createdBy = 'missing-person'
      }
    ],
    [
      '悬空合同',
      (db) => {
        db.versions[0].contractId = 'missing-contract'
      }
    ],
    [
      '跨组织归属',
      (db) => {
        db.messages[0].orgId = db.organizations.find(
          (org) =>
            ![
              db.transactions.find((tx) => tx.id === db.messages[0].transactionId)!.initiatorOrgId,
              db.transactions.find((tx) => tx.id === db.messages[0].transactionId)!
                .counterpartyOrgId
            ].includes(org.id)
        )!.id
      }
    ],
    [
      '版本空洞',
      (db) => {
        db.versions[0].number = 99
      }
    ],
    [
      '跨合同最终版本',
      (db) => {
        db.contracts[0].finalVersionId = db.versions.find(
          (v) => v.contractId !== db.contracts[0].id
        )!.id
      }
    ],
    [
      '跨组织方案依据',
      (db) => {
        db.proposals[0].orgId = db.transactions.find(
          (tx) => tx.id === db.proposals[0].transactionId
        )!.counterpartyOrgId
      }
    ]
  ]
  for (const [label, mutate] of mutations)
    await t.test(label, async (sub) => {
      const snapshot = createSeedDatabase()
      mutate(snapshot)
      const { db, migrate } = await fixture(sub, snapshot)
      const original = (await db.query('SELECT payload,revision FROM business_state')).rows
      await assert.rejects(migrate())
      assert.deepEqual(
        (await db.query('SELECT payload,revision FROM business_state')).rows,
        original
      )
      assert.equal(
        (
          await db.query<{ name: string | null }>(
            "SELECT to_regclass('business_transactions') AS name"
          )
        ).rows[0].name,
        null
      )
    })
})

test('003：空001快照可迁移，无需伪造目录或示例业务', async (t) => {
  const { db, migrate } = await fixture(t, emptyBusinessDatabase())
  await db.query("UPDATE business_state SET payload='{}'")
  await migrate()
  assert.equal((await db.query('SELECT * FROM business_transactions')).rows.length, 0)
})

test('作用域SQL：第三方交易、未获邀交易、他方公司账户与公司claims不加载', async (t) => {
  const seed = createSeedDatabase()
  const privateTx = structuredClone(seed.transactions[0])
  privateTx.id = 'uninvited-private-tx'
  privateTx.counterpartyStatus = 'none'
  seed.transactions.push(privateTx)
  const { db, snapshot, migrate } = await fixture(t, seed)
  await migrate()
  await db.transaction(async (tx) => {
    const counterparty = await loadBusinessDatabase(adapt(tx), privateTx.counterpartyOrgId, false)
    assert.ok(!counterparty.transactions.some((item) => item.id === privateTx.id))
    const owner = await loadBusinessDatabase(adapt(tx), privateTx.initiatorOrgId, false)
    assert.ok(owner.transactions.some((item) => item.id === privateTx.id))
  })
  await db.query(
    "INSERT INTO organizations(id,name,short_name) VALUES('outsider','第三方','第三方')"
  )
  await db.transaction(async (tx) => {
    const outsider = await loadBusinessDatabase(adapt(tx), 'outsider', false)
    for (const key of Object.keys(BUSINESS_TABLES))
      assert.equal(outsider[key as keyof typeof BUSINESS_TABLES].length, 0)
  })
  const orgId = snapshot.transactions[0].initiatorOrgId
  const queries: { sql: string; values: unknown[] }[] = []
  await db.transaction(async (tx) => {
    const scoped = await loadBusinessDatabase(adapt(tx, queries), orgId, false)
    assert.ok(scoped.transactions.length)
    assert.ok(
      scoped.transactions.every(
        (x) =>
          x.initiatorOrgId === orgId ||
          (x.counterpartyOrgId === orgId && x.counterpartyStatus !== 'none')
      )
    )
    assert.ok(scoped.cashAccounts.every((x) => x.orgId === orgId))
    assert.ok(scoped.claims.every((x) => x.transactionId !== null || x.orgId === orgId))
    assert.ok(scoped.proposals.every((x) => x.orgId === orgId))
  })
  assert.ok(queries.every(({ sql }) => !sql.includes('business_state')))
  const loads = queries.filter(({ sql }) => sql.includes('SELECT') && sql.includes('payload'))
  assert.equal(loads.length, 13)
  assert.ok(loads.every(({ sql }) => sql.includes('WHERE')))
})

test('diff：修改单一交易只写变更行且保留他方私有数据与第三方新写入', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  await migrate()
  const orgId = snapshot.transactions[0].initiatorOrgId
  const before = (await db.query('SELECT id,payload FROM business_cash_accounts ORDER BY id')).rows
  const statements: { sql: string; values: unknown[] }[] = []
  await db.transaction(async (tx) => {
    const client = adapt(tx, statements)
    const scoped = await loadBusinessDatabase(client, orgId, true)
    const baseline = snapshotBusiness(scoped)
    const original = scoped.transactions[0]
    original.name = '只更新当前交易'
    await tx.query(
      "INSERT INTO organizations(id,name,short_name) VALUES('late-org','新增第三方','新增第三方')"
    )
    await tx.query('INSERT INTO business_cash_accounts(id,payload) VALUES($1,$2)', [
      'late-account',
      JSON.stringify({
        id: 'late-account',
        orgId: 'late-org',
        label: '新账户',
        openingBalance: 1,
        asOf: '2026-10-20'
      })
    ])
    await persistBusinessDatabase(client, scoped, baseline, orgId)
  })
  assert.equal(statements.filter(({ sql }) => sql.startsWith('UPDATE business_')).length, 1)
  assert.equal(statements.filter(({ sql }) => sql.includes('business_counsel_grants')).length, 0)
  assert.equal(statements.filter(({ sql }) => sql.startsWith('DELETE FROM business_')).length, 0)
  assert.deepEqual(
    (
      await db.query(
        "SELECT id,payload FROM business_cash_accounts WHERE id<>'late-account' ORDER BY id"
      )
    ).rows,
    before
  )
  assert.equal(
    (await db.query("SELECT id FROM business_cash_accounts WHERE id='late-account'")).rows.length,
    1
  )
})

test('diff：未加载实体ID冲突不能UPSERT覆盖，陈旧快照CAS失败', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  await migrate()
  const orgId = snapshot.transactions[0].initiatorOrgId
  const otherOrgId = snapshot.organizations.find((org) => org.id !== orgId)!.id
  await db.query('INSERT INTO business_cash_accounts(id,payload) VALUES($1,$2)', [
    'foreign-account',
    JSON.stringify({
      id: 'foreign-account',
      orgId: otherOrgId,
      label: '他方账户',
      openingBalance: 1,
      asOf: '2026-10-20'
    })
  ])
  await assert.rejects(
    db.transaction(async (tx) => {
      const client = adapt(tx)
      const scoped = await loadBusinessDatabase(client, orgId, true)
      const baseline = snapshotBusiness(scoped)
      scoped.cashAccounts.push({
        id: 'foreign-account',
        orgId,
        label: '伪造账户',
        openingBalance: 1,
        asOf: '2026-10-20'
      })
      await persistBusinessDatabase(client, scoped, baseline, orgId)
    }),
    (error: unknown) => (error as { code: string }).code === '23505'
  )
  await assert.rejects(
    db.transaction(async (tx) => {
      const client = adapt(tx)
      const scoped = await loadBusinessDatabase(client, orgId, true)
      const baseline = snapshotBusiness(scoped)
      scoped.transactions[0].name = '过期修改'
      await tx.query(
        "UPDATE business_transactions SET payload=jsonb_set(payload,'{name}','\"已变更\"') WHERE id=$1",
        [scoped.transactions[0].id]
      )
      await persistBusinessDatabase(client, scoped, baseline, orgId)
    }),
    /并发修改/
  )
})

test('锁语义：只锁本企业业务scope，可见共享交易按id顺序锁，读取不取排他锁', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  await migrate()
  const orgId = snapshot.transactions[0].initiatorOrgId
  for (const write of [true, false]) {
    const queries: { sql: string; values: unknown[] }[] = []
    await db.transaction(async (tx) => loadBusinessDatabase(adapt(tx, queries), orgId, write))
    const locks = queries.filter(({ sql }) => /FOR (UPDATE|SHARE)/.test(sql))
    assert.equal(locks.length, 2)
    assert.ok(locks[0].sql.includes('business_org_scopes WHERE org_id=$1'))
    assert.deepEqual(locks[0].values, [orgId])
    assert.ok(locks[1].sql.includes('ORDER BY id FOR'))
    assert.ok(locks.every(({ sql }) => sql.endsWith(write ? 'UPDATE' : 'SHARE')))
    assert.ok(queries.every(({ sql }) => !sql.includes('FROM organizations')))
  }
})

test('锁后可见集合变化：拒绝陈旧加载且不逆序追加交易锁', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  await migrate()
  const orgId = snapshot.transactions[0].counterpartyOrgId
  const queries: string[] = []
  await assert.rejects(
    db.transaction(async (tx) => {
      const delegate = adapt(tx)
      const client = {
        query: async (sql: string, values: unknown[] = []) => {
          queries.push(sql)
          const result = await delegate.query(sql, values)
          if (sql.includes('business_transactions') && sql.includes('ORDER BY id FOR UPDATE')) {
            const invited = {
              ...structuredClone(snapshot.transactions[0]),
              id: 'late-visible-tx',
              counterpartyStatus: 'invited'
            }
            await tx.query('INSERT INTO business_transactions(id,payload) VALUES($1,$2)', [
              invited.id,
              JSON.stringify(invited)
            ])
          }
          return result
        }
      } as unknown as PoolClient
      await loadBusinessDatabase(client, orgId, true)
    }),
    (error: unknown) =>
      (error as { status?: number; code?: string }).status === 409 &&
      (error as { code?: string }).code === 'CONFLICT'
  )
  assert.equal(
    queries.filter((sql) => sql.includes('business_transactions') && sql.includes('FOR UPDATE'))
      .length,
    1
  )
})

test('实时摘要：无锁只读，隐藏对手私有合同消息财务，感知共享内容变化', async (t) => {
  const { db, snapshot, migrate } = await fixture(t)
  await migrate()
  const tx = snapshot.transactions[0]
  const principal = {
    userId: tx.createdBy,
    name: '摘要测试',
    email: 'fingerprint@example.test',
    sessionId: 'fingerprint',
    actingOrgId: tx.counterpartyOrgId
  }
  const queries: { sql: string; values: unknown[] }[] = []
  const fingerprint = (role: 'business' | 'legal' = 'business') =>
    tenantChangeFingerprint(adapt(db, queries), principal, role)
  const before = await fingerprint()
  assert.ok(queries.every(({ sql }) => !/FOR (UPDATE|SHARE)|INSERT|DELETE|UPDATE /.test(sql)))
  const contract = snapshot.contracts.find((c) => c.transactionId === tx.id)!
  const hiddenContract = {
    ...structuredClone(contract),
    id: 'hidden-contract',
    sharedWithCounterparty: false,
    sharedAt: null,
    finalVersionId: null
  }
  await db.query('INSERT INTO business_contracts(id,payload) VALUES($1,$2)', [
    hiddenContract.id,
    JSON.stringify(hiddenContract)
  ])
  const hiddenMessage = {
    id: 'hidden-message',
    transactionId: tx.id,
    authorId: tx.createdBy,
    orgId: tx.initiatorOrgId,
    body: '对手内部文本',
    visibility: 'internal',
    createdAt: '2026-10-20T00:00:00Z'
  }
  await db.query('INSERT INTO business_messages(id,payload) VALUES($1,$2)', [
    hiddenMessage.id,
    JSON.stringify(hiddenMessage)
  ])
  await db.query('INSERT INTO business_cash_accounts(id,payload) VALUES($1,$2)', [
    'hidden-account',
    JSON.stringify({
      id: 'hidden-account',
      orgId: tx.initiatorOrgId,
      label: '对手私有余额',
      openingBalance: 321,
      asOf: '2026-10-20'
    })
  ])
  assert.equal(await fingerprint(), before)
  const legalBefore = await fingerprint('legal')
  await db.query('INSERT INTO business_cash_accounts(id,payload) VALUES($1,$2)', [
    'own-account',
    JSON.stringify({
      id: 'own-account',
      orgId: principal.actingOrgId,
      label: '自有余额',
      openingBalance: 456,
      asOf: '2026-10-20'
    })
  ])
  assert.equal(await fingerprint('legal'), legalBefore)
  assert.notEqual(await fingerprint(), before)
  const visibleBefore = await fingerprint('legal')
  await db.query(
    "UPDATE business_messages SET payload=jsonb_set(payload,'{visibility}','\"shared\"') WHERE id=$1",
    [hiddenMessage.id]
  )
  assert.notEqual(await fingerprint('legal'), visibleBefore)
})
