import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NexusService, sanitizeHtml } from '../src/shared/service.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSeedDatabase } from '../src/shared/seed.ts'
import { NexusError } from '../src/shared/types.ts'

function fresh() {
  let changes = 0
  const svc = new NexusService(createSeedDatabase(), () => changes++)
  return { svc, changes: () => changes }
}

function expectError(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof NexusError && e.code === code, `expected ${code}`)
}

test('full negotiation flow between company A and company B', () => {
  const { svc, changes } = fresh()
  // A creates transaction + contract from template
  const tx = svc.createTransaction('u_a_biz', {
    name: '测试采购',
    type: '设备采购',
    counterpartyOrgId: 'org_yuanhang',
    amount: 100000,
    expectedSignDate: '2026-12-31',
    description: ''
  })
  assert.equal(tx.status, 'draft')
  const ct = svc.createContract('u_a_biz', tx.id, '测试合同', 'tpl_purchase')
  assert.equal(ct.clauses.length, 6)
  // Before invitation B sees nothing
  assert.equal(
    buildViewState(svc.db, 'u_b_biz').transactions.some((t) => t.id === tx.id),
    false
  )
  expectError(() => svc.shareContract('u_a_biz', ct.id), 'CONFLICT')

  svc.inviteCounterparty('u_a_biz', tx.id)
  svc.shareContract('u_a_biz', ct.id)
  svc.acceptInvitation('u_b_biz', tx.id)

  // B sees the shared contract and proposes a change
  const bView = buildViewState(svc.db, 'u_b_biz')
  assert.ok(bView.contracts.some((c) => c.id === ct.id))
  const clause = ct.clauses[2]
  const sg = svc.createSuggestion(
    'u_b_biz',
    ct.id,
    clause.id,
    '<p>修改后的交付条款</p>',
    '延长交付期'
  )
  expectError(() => svc.resolveSuggestion('u_b_biz', sg.id, true), 'PERMISSION_DENIED') // cannot approve own

  // A replies, accepts, saves a version
  const cm = svc.addComment('u_b_biz', ct.id, clause.id, '请考虑', 'shared')
  svc.addComment('u_a_biz', ct.id, clause.id, '已收到', 'shared', cm.id)
  svc.resolveSuggestion('u_a_biz', sg.id, true)
  assert.equal(
    svc.db.contracts.find((c) => c.id === ct.id)!.clauses[2].body,
    '<p>修改后的交付条款</p>'
  )
  const v = svc.saveVersion('u_a_biz', ct.id, '第二版')
  assert.equal(v.number, 2)

  // A invites outside counsel, who adds a counsel-only opinion
  svc.grantCounsel('u_a_legal', tx.id, 'u_a_counsel')
  svc.addComment('u_a_counsel', ct.id, clause.id, '律师意见：可行', 'counsel')
  assert.ok(buildViewState(svc.db, 'u_a_biz').comments.some((c) => c.body.includes('律师意见')))
  assert.ok(!buildViewState(svc.db, 'u_b_biz').comments.some((c) => c.body.includes('律师意见')))

  // Both confirm the final version
  svc.confirmFinal('u_a_biz', ct.id, v.id)
  assert.equal(svc.db.contracts.find((c) => c.id === ct.id)!.status, 'negotiating')
  svc.confirmFinal('u_b_biz', ct.id, v.id)
  assert.equal(svc.db.contracts.find((c) => c.id === ct.id)!.status, 'finalized')
  assert.equal(svc.db.transactions.find((t) => t.id === tx.id)!.status, 'pending_signature')
  expectError(() => svc.updateClauses('u_a_biz', ct.id, ct.clauses), 'CONFLICT')

  // Milestones
  const ms = svc.createMilestone('u_a_biz', {
    transactionId: tx.id,
    name: '预付款',
    responsibleOrgId: 'org_qiming',
    dueDate: '2027-01-10'
  })
  assert.equal(svc.updateMilestone('u_b_biz', ms.id, { status: 'completed' }).status, 'completed')
  assert.ok(changes() > 10, 'persistence callback should fire on every mutation')
})

test('permission failures', () => {
  const { svc } = fresh()
  expectError(
    () =>
      svc.createTransaction('u_a_counsel', {
        name: 'x',
        type: 'x',
        counterpartyOrgId: 'org_yuanhang',
        amount: 1,
        expectedSignDate: '2026-12-01',
        description: ''
      }),
    'PERMISSION_DENIED'
  )
  expectError(
    () => svc.createSuggestion('u_a_counsel', 'ct_equip', 'cl_e3', '<p>x</p>', 'x'),
    'PERMISSION_DENIED'
  )
  // B (counterparty) cannot edit the owner's draft clauses
  expectError(
    () => svc.updateClauses('u_b_biz', 'ct_equip', svc.db.contracts[0].clauses),
    'PERMISSION_DENIED'
  )
  // Company C cannot even see tx_equip
  expectError(() => svc.addComment('u_c_biz', 'ct_equip', 'cl_e1', 'hi', 'shared'), 'NOT_FOUND')
  // Counsel cannot post a shared comment
  expectError(
    () => svc.addComment('u_a_counsel', 'ct_equip', 'cl_e1', 'hi', 'shared'),
    'PERMISSION_DENIED'
  )
  // B cannot reply to A's internal comment (it does not even exist for B)
  expectError(
    () => svc.addComment('u_b_legal', 'ct_equip', 'cl_e5', 'hi', 'shared', 'cm_3'),
    'NOT_FOUND'
  )
  // Counsel cannot read the other party's thread
  expectError(
    () => svc.addComment('u_a_counsel', 'ct_equip', 'cl_e4', 'hi', 'counsel', 'cm_5'),
    'NOT_FOUND'
  )
})

test('replying to an internal thread cannot be made shared', () => {
  const { svc } = fresh()
  expectError(
    () => svc.addComment('u_a_biz', 'ct_equip', 'cl_e5', 'oops', 'shared', 'cm_3'),
    'PERMISSION_DENIED'
  )
  const ok = svc.addComment('u_a_biz', 'ct_equip', 'cl_e5', '收到', 'internal', 'cm_3')
  assert.equal(ok.visibility, 'internal')
})

test('stale suggestion cannot overwrite newer clause text', () => {
  const { svc } = fresh()
  const sg = svc.db.suggestions.find((s) => s.id === 'sg_3')!
  svc.db.contracts.find((c) => c.id === 'ct_equip')!.clauses.find((c) => c.id === 'cl_e5')!.body =
    '<p>被改过</p>'
  expectError(() => svc.resolveSuggestion('u_a_legal', sg.id, true), 'CONFLICT')
})

test('restoring a version creates a new version and keeps history', () => {
  const { svc } = fresh()
  const before = svc.db.versions.filter((v) => v.contractId === 'ct_equip').length
  svc.restoreVersion('u_a_biz', 'ct_equip', 'ver_e2')
  const after = svc.db.versions.filter((v) => v.contractId === 'ct_equip')
  assert.equal(after.length, before + 1)
  assert.ok(svc.db.contracts.find((c) => c.id === 'ct_equip')!.clauses[2].body.includes('30 日'))
})

test('confirming a stale version is rejected', () => {
  const { svc } = fresh()
  expectError(() => svc.confirmFinal('u_a_biz', 'ct_equip', 'ver_e2'), 'CONFLICT')
})

test('input validation', () => {
  const { svc } = fresh()
  expectError(
    () =>
      svc.createTransaction('u_a_biz', {
        name: ' ',
        type: 'x',
        counterpartyOrgId: 'org_yuanhang',
        amount: 1,
        expectedSignDate: '2026-12-01',
        description: ''
      }),
    'INVALID_INPUT'
  )
  expectError(
    () =>
      svc.createTransaction('u_a_biz', {
        name: 'x',
        type: 'x',
        counterpartyOrgId: 'org_qiming',
        amount: 1,
        expectedSignDate: '2026-12-01',
        description: ''
      }),
    'INVALID_INPUT'
  )
  expectError(
    () =>
      svc.createTransaction('u_a_biz', {
        name: 'x',
        type: 'x',
        counterpartyOrgId: 'org_yuanhang',
        amount: -5,
        expectedSignDate: '2026-12-01',
        description: ''
      }),
    'INVALID_INPUT'
  )
  expectError(
    () =>
      svc.createTransaction('u_a_biz', {
        name: 'x',
        type: 'x',
        counterpartyOrgId: 'org_yuanhang',
        amount: 1,
        expectedSignDate: 'tomorrow',
        description: ''
      }),
    'INVALID_INPUT'
  )
  expectError(
    () =>
      svc.createTransaction('u_a_biz', {
        name: 'x',
        type: 'x',
        counterpartyOrgId: 'org_mingheng',
        amount: 1,
        expectedSignDate: '2026-12-01',
        description: ''
      }),
    'INVALID_INPUT'
  )
})

test('sanitizeHtml strips scripts and event handlers', () => {
  const dirty =
    '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)>'
  const clean = sanitizeHtml(dirty)
  assert.ok(!/<script/i.test(clean))
  assert.ok(!/onclick|onerror/i.test(clean))
  assert.ok(!/javascript:/i.test(clean))
  assert.ok(clean.includes('hi'))
})
