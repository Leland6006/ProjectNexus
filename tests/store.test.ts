import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/main/store.ts'
import { createSession, handleCall } from '../src/main/handlers.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-test-'))
}

test('data survives a restart (save -> new store -> load)', async () => {
  const dir = tmp()
  try {
    const store1 = new JsonStore(dir)
    const loaded = store1.load()
    const session = createSession(loaded.db, loaded.currentUserId, (s) =>
      store1.save({ db: s.service.db, currentUserId: s.currentUserId })
    )
    assert.equal((await handleCall(session, 'switchUser', ['u_b_biz'])).ok, true)
    const created = await handleCall(session, 'createTransaction', [
      {
        name: '重启测试交易',
        type: '采购',
        counterpartyOrgId: 'org_qiming',
        amount: 5,
        expectedSignDate: '2026-12-01',
        description: ''
      }
    ])
    // u_b_biz belongs to org_yuanhang so org_qiming is a valid counterparty
    assert.equal(created.ok, true)
    store1.flush()

    const store2 = new JsonStore(dir)
    const reloaded = store2.load()
    assert.equal(reloaded.currentUserId, 'u_b_biz')
    assert.ok(reloaded.db.transactions.some((t) => t.name === '重启测试交易'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt data file is preserved and replaced with fresh demo data', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'nexus-data.json'), '{ not json')
    const loaded = new JsonStore(dir).load()
    assert.ok(loaded.db.transactions.length >= 3)
    assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleCall rejects unknown methods and bad arguments without throwing', async () => {
  const dir = tmp()
  try {
    const store = new JsonStore(dir)
    const l = store.load()
    const session = createSession(l.db, l.currentUserId, () => {})
    const unknown = await handleCall(session, 'dropAllTables', [])
    assert.equal(unknown.ok, false)
    const bad = await handleCall(session, 'createTransaction', ['not an object'])
    assert.equal(bad.ok, false)
    const notMine = await handleCall(session, 'switchUser', ['nobody'])
    assert.equal(notMine.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state returned to the renderer is filtered for the acting user', async () => {
  const dir = tmp()
  try {
    const l = new JsonStore(dir).load()
    const session = createSession(l.db, l.currentUserId, () => {})
    const r = await handleCall(session, 'switchUser', ['u_b_biz'])
    assert.ok(r.ok)
    if (r.ok) assert.ok(!r.state.comments.some((c) => c.body.includes('是我方底线')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
