import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildViewState, effectiveOrgId } from '../src/shared/permissions.ts'
import { createSeedDatabase, ORG_A, ORG_B, ORG_LAW } from '../src/shared/seed.ts'
import type { Database } from '../src/shared/types.ts'
import { JsonStore } from '../src/main/store.ts'
import { createSession, handleCall } from '../src/main/handlers.ts'

const NOW = '2026-10-17T09:00:00.000Z'

/** Counsel authorised by *both* parties of tx_equip, with an opinion written for each. */
function dualGranted(): Database {
  const db = createSeedDatabase()
  const tx = db.transactions.find((t) => t.id === 'tx_equip')!
  tx.counselGrants.push({
    userId: 'u_a_counsel',
    grantedByOrgId: ORG_B,
    grantedByUserId: 'u_b_legal',
    grantedAt: NOW
  })
  db.comments.push(
    {
      id: 'cm_b_counsel',
      contractId: 'ct_equip',
      clauseId: 'cl_e3',
      parentId: null,
      authorId: 'u_a_counsel',
      orgId: ORG_B,
      body: '【远航侧律师意见】交付期可接受。',
      visibility: 'counsel',
      createdAt: NOW
    },
    {
      id: 'cm_a_counsel',
      contractId: 'ct_equip',
      clauseId: 'cl_e3',
      parentId: null,
      authorId: 'u_a_counsel',
      orgId: ORG_A,
      body: '【启明侧律师意见】建议缩短质保期。',
      visibility: 'counsel',
      createdAt: NOW
    }
  )
  return db
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-counsel-'))
}

test('effectiveOrgId keeps the first grant when no side is chosen', () => {
  const db = dualGranted()
  const tx = db.transactions.find((t) => t.id === 'tx_equip')!
  const counsel = db.users.find((u) => u.id === 'u_a_counsel')!
  assert.equal(effectiveOrgId(counsel, tx), ORG_A)
})

test('effectiveOrgId honours the chosen side and rejects a side that never granted access', () => {
  const db = dualGranted()
  const tx = db.transactions.find((t) => t.id === 'tx_equip')!
  const counsel = db.users.find((u) => u.id === 'u_a_counsel')!
  assert.equal(effectiveOrgId(counsel, tx, ORG_B), ORG_B)
  // ORG_LAW is the counsel's own firm, not a party: asking for it falls back to grant 1.
  assert.equal(effectiveOrgId(counsel, tx, ORG_LAW), ORG_A)
})

test('a counsel granted by both parties only sees the side they are acting for', () => {
  const db = dualGranted()
  const forA = buildViewState(db, 'u_a_counsel', { representingOrgId: ORG_A })
  const forB = buildViewState(db, 'u_a_counsel', { representingOrgId: ORG_B })

  assert.ok(forA.comments.some((c) => c.id === 'cm_a_counsel'))
  assert.ok(!forA.comments.some((c) => c.id === 'cm_b_counsel'), 'B-side opinion leaked to the A-side view')
  assert.ok(forB.comments.some((c) => c.id === 'cm_b_counsel'))
  assert.ok(!forB.comments.some((c) => c.id === 'cm_a_counsel'), 'A-side opinion leaked to the B-side view')
})

test('switching the represented side goes through the IPC allowlist', () => {
  const dir = tmp()
  try {
    const loaded = new JsonStore(dir).load()
    const db = loaded.db
    const tx = db.transactions.find((t) => t.id === 'tx_equip')!
    tx.counselGrants.push({ userId: 'u_a_counsel', grantedByOrgId: ORG_B, grantedByUserId: 'u_b_legal', grantedAt: NOW })
    const session = createSession(db, 'u_a_counsel', () => {})

    const denied = handleCall(session, 'setRepresentingOrg', [ORG_LAW])
    assert.equal(denied.ok, false, 'counsel must not claim a firm that never granted access')

    const ok = handleCall(session, 'setRepresentingOrg', [ORG_B])
    assert.equal(ok.ok, true)
    if (ok.ok) assert.equal(ok.state.representingOrgId, ORG_B)

    const cleared = handleCall(session, 'setRepresentingOrg', [null])
    assert.equal(cleared.ok, true)
    if (cleared.ok) assert.equal(cleared.state.representingOrgId, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only external counsel may pick a represented organisation', () => {
  const dir = tmp()
  try {
    const loaded = new JsonStore(dir).load()
    const session = createSession(loaded.db, 'u_a_biz', () => {})
    const r = handleCall(session, 'setRepresentingOrg', [ORG_B])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'PERMISSION_DENIED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('switching account clears the delegated authority', () => {
  const dir = tmp()
  try {
    const loaded = new JsonStore(dir).load()
    const db = loaded.db
    db.transactions.find((t) => t.id === 'tx_equip')!.counselGrants.push({
      userId: 'u_a_counsel',
      grantedByOrgId: ORG_B,
      grantedByUserId: 'u_b_legal',
      grantedAt: NOW
    })
    const session = createSession(db, 'u_a_counsel', () => {})
    assert.equal(handleCall(session, 'setRepresentingOrg', [ORG_B]).ok, true)
    assert.equal(handleCall(session, 'switchUser', ['u_a_biz']).ok, true)
    const after = handleCall(session, 'getState', [])
    if (after.ok) assert.equal(after.state.representingOrgId, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the directory only contains organisations the user actually deals with', () => {
  const db = createSeedDatabase()
  const c = buildViewState(db, 'u_c_biz')
  const orgIds = c.organizations.map((o) => o.id).sort()
  assert.deepEqual(orgIds, [ORG_A, 'org_huaxin'].sort())
  assert.ok(!c.users.some((u) => u.id === 'u_b_biz'), 'unrelated company B member leaked into the directory')
  assert.ok(!c.users.some((u) => u.id === 'u_a_counsel'), 'counsel of another deal leaked into the directory')
})

test('the full account list is only shipped in demo mode', () => {
  const db = createSeedDatabase()
  assert.equal(buildViewState(db, 'u_c_biz').demoAccounts, null)
  const demo = buildViewState(db, 'u_c_biz', { demoDirectory: true })
  assert.equal(demo.demoAccounts?.users.length, db.users.length)
  assert.equal(demo.demoAccounts?.organizations.length, db.organizations.length)
})
