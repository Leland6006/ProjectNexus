import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { AUTH_SCHEMA } from './auth.ts'

/** Versioned, transactional bootstrap. Never silently replay an edited migration. */
export async function migrate(pool: Pool): Promise<void> {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
  const migrations = [{ version: '001_identity_foundation', sql: `${schema}\n${AUTH_SCHEMA}` }]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Coordinate multiple API processes before creating/updating the migration ledger.
    await client.query('SELECT pg_advisory_xact_lock(683214170)')
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const applied = await client.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version')
    for (const row of applied.rows) {
      if (!migrations.some((migration) => migration.version === row.version)) throw new Error('Database migration is newer than this API')
    }
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      const existing = applied.rows.find((row) => row.version === migration.version)
      if (existing) {
        if (existing.checksum !== checksum) throw new Error('Applied migration checksum mismatch')
        continue
      }
      if (!applied.rows.length) {
        const legacy = await client.query<{ name: string | null }>("SELECT to_regclass('public.identities')::text AS name")
        if (legacy.rows[0].name) throw new Error('Unversioned identity schema detected; back up and migrate explicitly before starting')
      }
      await client.query(migration.sql)
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [migration.version, checksum])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}
