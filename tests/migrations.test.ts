import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrateDatabase,
  type MigrationStep
} from '../src/shared/migrations.ts'
import { createSeedDatabase } from '../src/shared/seed.ts'
import { JsonStore } from '../src/main/store.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-migrate-'))
}

test('a current-version database is accepted unchanged', () => {
  const db = createSeedDatabase()
  const r = migrateDatabase(db)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.db, db)
    assert.equal(r.fromVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(db.schemaVersion, CURRENT_SCHEMA_VERSION)
  }
})

test('a file without schemaVersion is adopted as the current version', () => {
  const db = createSeedDatabase()
  delete (db as Partial<typeof db>).schemaVersion
  const r = migrateDatabase(db)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.db.schemaVersion, CURRENT_SCHEMA_VERSION)
})

test('a database from a newer release is refused, not silently reset', () => {
  const db = createSeedDatabase()
  db.schemaVersion = CURRENT_SCHEMA_VERSION + 5
  const r = migrateDatabase(db)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /更新的版本/)
})

test('a missing migration step is reported instead of discarding data', () => {
  const db = createSeedDatabase()
  const r = migrateDatabase(db, CURRENT_SCHEMA_VERSION + 1)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /缺少从 v/)
})

test('migration steps run in order and bump the version', () => {
  const db = createSeedDatabase()
  db.schemaVersion = 1
  const seen: number[] = []
  const steps: MigrationStep[] = [
    { from: 1, to: 2, up: (d) => void (seen.push(d.schemaVersion), (d.schemaVersion = 2)) },
    { from: 2, to: 3, up: (d) => void (seen.push(d.schemaVersion), (d.schemaVersion = 3)) }
  ]
  const original = MIGRATIONS.slice()
  MIGRATIONS.length = 0
  steps.forEach((s) => MIGRATIONS.push(s))
  try {
    const r = migrateDatabase(db, 3)
    assert.equal(r.ok, true)
    assert.deepEqual(seen, [1, 2])
    assert.equal(db.schemaVersion, 3)
  } finally {
    MIGRATIONS.length = 0
    original.forEach((s) => MIGRATIONS.push(s))
  }
})

test('store migrates an old file in place and keeps it', () => {
  const dir = tmp()
  try {
    const db = createSeedDatabase()
    delete (db as Partial<typeof db>).schemaVersion
    writeFileSync(join(dir, 'nexus-data.json'), JSON.stringify({ db, currentUserId: 'u_a_biz' }))

    const loaded = new JsonStore(dir).load()
    assert.equal(loaded.db.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(loaded.currentUserId, 'u_a_biz')
    const reread = JSON.parse(readFileSync(join(dir, 'nexus-data.json'), 'utf8'))
    assert.equal(reread.db.schemaVersion, CURRENT_SCHEMA_VERSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unusable files are archived with a reason and demo data is restored', () => {
  const dir = tmp()
  try {
    const db = createSeedDatabase()
    db.schemaVersion = 99
    writeFileSync(join(dir, 'nexus-data.json'), JSON.stringify({ db, currentUserId: 'u_a_biz' }))
    const loaded = new JsonStore(dir).load()
    assert.ok(loaded.db.transactions.length >= 3)
    assert.ok(readdirSync(dir).some((f) => f.includes('.incompatible-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
