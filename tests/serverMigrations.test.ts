import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { migrate } from '../server/migrations.ts'

function poolFor(db: PGlite): Pool {
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      // PGlite has no multiple backend sessions: advisory locking is a network-PG check.
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (!values && sql.includes('CREATE TABLE IF NOT EXISTS identities')) { await db.exec(sql); return { rows: [] } }
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
  assert.equal((await db.query('SELECT version FROM schema_migrations')).rows.length, 1)
  await db.query("UPDATE schema_migrations SET checksum='modified'")
  await assert.rejects(migrate(pool), /checksum mismatch/)
  assert.equal((await db.query('SELECT id FROM identities')).rows.length, 1)
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
