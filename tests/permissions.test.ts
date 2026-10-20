import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSeedDatabase } from '../src/shared/seed.ts'

const db = createSeedDatabase()
const view = (id: string) => buildViewState(db, id)

test('company B cannot see company A internal comments or messages', () => {
  const b = view('u_b_legal')
  const bodies = b.comments.map((c) => c.body).join('\n')
  assert.ok(!bodies.includes('是我方底线'), 'A internal legal opinion leaked to B')
  assert.ok(!bodies.includes('律师意见'), 'A counsel opinion leaked to B')
  const msgs = view('u_b_biz')
    .messages.map((m) => m.body)
    .join('\n')
  assert.ok(!msgs.includes('采购预算上限'), 'A internal message leaked to B')
})

test('company A cannot see company B internal opinions', () => {
  const a = view('u_a_legal')
  assert.ok(
    !a.comments.some((c) => c.body.includes('核心部件供应商')),
    'B internal comment leaked to A'
  )
  assert.ok(
    !a.messages.some((m) => m.body.includes('守住交付周期')),
    'B internal message leaked to A'
  )
})

test('each side sees its own internal content', () => {
  assert.ok(view('u_a_legal').comments.some((c) => c.body.includes('是我方底线')))
  assert.ok(view('u_b_legal').comments.some((c) => c.body.includes('核心部件供应商')))
})

test('shared comments are visible to both parties', () => {
  for (const id of ['u_a_biz', 'u_b_biz']) {
    assert.ok(
      view(id).comments.some((c) => c.id === 'cm_1'),
      `${id} cannot see shared comment`
    )
  }
})

test('external counsel sees only what their granting org shares with counsel', () => {
  const l = view('u_a_counsel')
  assert.deepEqual(
    l.transactions.map((t) => t.id),
    ['tx_equip']
  )
  assert.ok(
    l.comments.some((c) => c.visibility === 'counsel'),
    'counsel cannot see counsel-visible comment'
  )
  assert.ok(l.comments.some((c) => c.visibility === 'shared'))
  assert.ok(
    !l.comments.some((c) => c.visibility === 'internal'),
    'counsel saw internal-only comment'
  )
  assert.ok(!l.messages.some((m) => m.visibility === 'internal'), 'counsel saw internal message')
})

test('company B cannot see that A hired outside counsel', () => {
  const b = view('u_b_biz')
  const tx = b.transactions.find((t) => t.id === 'tx_equip')!
  assert.equal(tx.counselGrants.length, 0)
  assert.ok(!b.activities.some((a) => a.type === 'counsel_invited'))
})

test('counterparty cannot see unshared contract, nor pre-share history', () => {
  const c = view('u_c_biz')
  // Company C is invited to tx_service, so it sees the transaction (needed to accept)
  // but not the still-unshared contract.
  assert.deepEqual(
    c.transactions.map((t) => t.id),
    ['tx_service']
  )
  assert.equal(c.contracts.length, 0)
  assert.equal(c.versions.length, 0)
  const b = view('u_b_biz')
  const v1 = b.versions.find((v) => v.id === 'ver_e1')
  assert.equal(v1, undefined, 'B saw the pre-share draft v1')
  assert.ok(b.versions.some((v) => v.id === 'ver_e2'))
})

test('company B cannot see company A unshared contract', () => {
  assert.ok(!view('u_b_biz').contracts.some((x) => x.id === 'ct_service'))
})

test('uninvolved parties see nothing of other transactions', () => {
  const c = view('u_c_biz')
  assert.ok(!c.transactions.some((t) => t.id === 'tx_equip' || t.id === 'tx_nda'))
  assert.equal(c.milestones.length, 0)
  assert.equal(c.comments.length, 0)
  assert.ok(!c.messages.some((m) => m.transactionId === 'tx_equip'))
})

test("invited-but-not-joined party cannot see the inviter's internal activity", () => {
  const c = view('u_c_biz')
  assert.ok(!c.activities.some((a) => a.id === 'a_21' || a.id === 'a_23'))
  assert.ok(c.activities.some((a) => a.id === 'a_22'))
})

test('internal activity of the other party is hidden', () => {
  const b = view('u_b_biz')
  assert.ok(!b.activities.some((a) => a.id === 'a_13'), 'A internal activity leaked to B')
  assert.ok(view('u_a_biz').activities.some((a) => a.id === 'a_13'))
})
