import { clausesFingerprint } from '../src/shared/terms.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAgentContext, confirmClaim, mergeClaim, selectPremises, visibleClaims } from '../src/shared/context.ts'
import { detectPaymentTermsChange, diffPaymentTerms, latestVersionPair } from '../src/shared/events.ts'
import { forecastCashflow, paymentSchedule } from '../src/shared/finance.ts'
import { approveProposal, NO_LLM, rejectProposal, routeAgents, runOrchestrator, isDuplicateProposal } from '../src/shared/orchestrator.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { claimsForProposal } from '../src/shared/proposalView.ts'
import { createSeedDatabase, DEFAULT_USER_ID, ORG_A, ORG_B } from '../src/shared/seed.ts'
import { NexusError, type Claim, type ContractVersion, type Database, type PaymentTerms } from '../src/shared/types.ts'

const TERMS_A: PaymentTerms = { prepayRate: 0.5, instalments: [], settlementDays: 15, payerOrgId: ORG_B, acceptanceDate: '2026-11-05' }
const TERMS_B: PaymentTerms = { prepayRate: 0.1, instalments: [], settlementDays: 15, payerOrgId: ORG_B, acceptanceDate: '2026-11-05' }

const TX = 'tx_equip'
const CONTRACT = 'ct_equip'

function version(n: number, terms: PaymentTerms | null): ContractVersion {
  return {
    id: `ver_${n}`,
    contractId: CONTRACT,
    number: n,
    label: `v${n}`,
    note: '',
    clauses: [],
    paymentTerms: terms,
    authorId: DEFAULT_USER_ID,
    createdAt: `2026-10-1${n}T09:00:00.000Z`
  }
}

/** Contract worth ¥1,280,000, ¥150,000 cash, ¥620,000 cost due before settlement. */
function scenario(): Database {
  const db = createSeedDatabase()
  const contract = db.contracts.find((c) => c.id === CONTRACT)!
  contract.paymentTerms = { ...TERMS_B, verifiedClausesFingerprint: clausesFingerprint(contract.clauses) }
  db.versions = db.versions.filter((v) => v.contractId !== CONTRACT)
  db.versions.push(version(1, TERMS_A), version(2, TERMS_B))
  return db
}

test('structured terms produce numbers, which a text diff never could', () => {
  const delta = diffPaymentTerms(TERMS_A, TERMS_B, 1_280_000)
  assert.ok(delta)
  assert.equal(delta.prepayRateFrom, 0.5)
  assert.equal(delta.prepayRateTo, 0.1)
  assert.equal(delta.prepayAmountFrom, 640_000)
  assert.equal(delta.prepayAmountTo, 128_000)
  assert.equal(delta.prepayAmountDelta, -512_000)
})

test('identical terms produce no event', () => {
  assert.equal(diffPaymentTerms(TERMS_A, { ...TERMS_A }, 1_280_000), null)
})

test('a prepayment change is detected from two version snapshots', () => {
  const db = scenario()
  const tx = db.transactions.find((t) => t.id === TX)!
  const contract = db.contracts.find((c) => c.id === CONTRACT)!
  const [prev, next] = latestVersionPair(db.versions, CONTRACT)
  const event = detectPaymentTermsChange({
    transaction: tx,
    contract,
    previous: prev,
    next,
    at: '2026-10-18T09:00:00.000Z',
    makeId: (p) => `${p}_1`
  })
  assert.ok(event)
  assert.equal(event.type, 'payment_terms_changed')
  assert.equal(event.payload.prepayAmountDelta, -512_000)
})

test('the same change makes the difference between solvent and short', () => {
  const db = scenario()
  const tx = db.transactions.find((t) => t.id === TX)!
  const account = db.cashAccounts.find((a) => a.orgId === ORG_A)!
  const costs = db.costItems.filter((c) => c.transactionId === TX)

  const before = forecastCashflow({ transaction: tx, terms: TERMS_A, costs, account })
  assert.equal(before.shortfall, 0)

  const after = forecastCashflow({ transaction: tx, terms: TERMS_B, costs, account })
  assert.equal(after.shortfall, 342_000)
  assert.equal(after.shortfallDate, '2026-11-10')
  assert.equal(
    paymentSchedule(tx, TERMS_B).find((l) => l.label === '预付款')?.amount,
    128_000
  )
})

test('routing is a rule, not a model guess', () => {
  const db = scenario()
  const tx = db.transactions.find((t) => t.id === TX)!
  const contract = db.contracts.find((c) => c.id === CONTRACT)!
  const [prev, next] = latestVersionPair(db.versions, CONTRACT)
  const event = detectPaymentTermsChange({
    transaction: tx,
    contract,
    previous: prev,
    next,
    at: '2026-10-18T09:00:00.000Z',
    makeId: (p) => `${p}_1`
  })
  assert.deepEqual(routeAgents(event), ['finance', 'legal', 'ops'])
  assert.deepEqual(routeAgents(null), [])
})

test('the finance step computes the gap without ever calling a model', async () => {
  const db = scenario()
  const result = await runOrchestrator({
    db,
    userId: DEFAULT_USER_ID,
    transactionId: TX,
    llm: null,
    now: '2026-10-18T10:00:00.000Z',
    makeId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`
  })

  assert.ok(result.event)
  const gap = result.claims.find((c) => c.key === 'cash.gap')
  assert.ok(gap)
  assert.equal(gap.numeric, 342_000)
  assert.equal(gap.status, 'inferred')

  const prepay = result.claims.find((c) => c.key === 'payment.prepay_amount')
  assert.equal(prepay?.status, 'confirmed')
  assert.equal(prepay?.numeric, 128_000)

  const finance = result.briefs.find((b) => b.agentId === 'finance')!
  assert.ok(finance.findings.some((f) => f.includes('342,000')))

  // No model means no judgement steps, but the draft still exists and still waits.
  assert.ok(result.proposal)
  assert.equal(result.proposal.status, 'pending')
  assert.equal(result.proposal.baseVersionId, 'ver_2')
})

test('agents see different slices of the same company memory', () => {
  const db = scenario()
  const legal = buildAgentContext(db, DEFAULT_USER_ID, 'legal', TX)
  const finance = buildAgentContext(db, DEFAULT_USER_ID, 'finance', TX)
  assert.ok(legal.clauses, 'the legal agent may read clause prose')
  assert.equal(finance.clauses, null, 'the finance agent gets numbers, not prose')
})

test('an internal claim of the other party stays invisible', () => {
  const db = scenario()
  const tx = db.transactions.find((t) => t.id === TX)!
  const user = db.users.find((u) => u.id === DEFAULT_USER_ID)!
  db.claims.push({
    id: 'cl_secret',
    orgId: ORG_B,
    transactionId: TX,
    key: 'cost.secret',
    label: '对方内部成本',
    value: '¥1',
    numeric: 1,
    unit: null,
    status: 'confirmed',
    source: { kind: 'user' },
    asOf: '2026-10-18',
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  })
  db.claims.push({
    id: 'cl_mine',
    orgId: ORG_A,
    transactionId: TX,
    key: 'cost.mine',
    label: '我方成本',
    value: '¥2',
    numeric: 2,
    unit: null,
    status: 'confirmed',
    source: { kind: 'user' },
    asOf: '2026-10-18',
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  })
  const ids = visibleClaims(db, user, tx).map((c) => c.id)
  assert.ok(ids.includes('cl_mine'))
  assert.ok(!ids.includes('cl_secret'))
})

test('an inference never overwrites a confirmed fact', () => {
  const claims: Claim[] = []
  const base = {
    orgId: ORG_A,
    transactionId: TX,
    label: '预付款比例',
    value: '50%',
    numeric: 0.5,
    unit: null,
    source: { kind: 'contract' as const },
    asOf: '2026-10-18',
    visibility: 'internal' as const,
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  }
  const confirmed: Claim = { ...base, id: 'cl_1', key: 'payment.prepay_rate', status: 'confirmed' }
  claims.push(confirmed)
  const inferred: Claim = { ...base, id: 'cl_2', key: 'payment.prepay_rate', status: 'inferred', numeric: 0.1 }

  const res = mergeClaim(claims, inferred)
  assert.equal(res.action, 'ignored')
  assert.equal(claims.length, 1)
  assert.equal(claims[0].numeric, 0.5)
})

test('a newer inference replaces the old one and keeps the trail', () => {
  const claims: Claim[] = []
  const mk = (id: string, n: number): Claim => ({
    id,
    orgId: ORG_A,
    transactionId: TX,
    key: 'cash.gap',
    label: '资金缺口',
    value: `¥${n}`,
    numeric: n,
    unit: null,
    status: 'inferred',
    source: { kind: 'agent' },
    asOf: '2026-10-18',
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  })
  assert.equal(mergeClaim(claims, mk('cl_1', 100)).action, 'added')
  const res = mergeClaim(claims, mk('cl_2', 200))
  assert.equal(res.action, 'replaced')
  assert.equal(claims[0].supersededById, 'cl_2')
})

test('only a person can promote an inference to a fact', () => {
  const inferred: Claim = {
    id: 'cl_1',
    orgId: ORG_A,
    transactionId: TX,
    key: 'cash.gap',
    label: '资金缺口',
    value: '¥100',
    numeric: 100,
    unit: null,
    status: 'inferred',
    source: { kind: 'agent' },
    asOf: '2026-10-18',
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  }
  const confirmed = confirmClaim(inferred, DEFAULT_USER_ID, '2026-10-18T12:00:00.000Z')
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.confirmedBy, DEFAULT_USER_ID)
  assert.throws(() => confirmClaim(confirmed, DEFAULT_USER_ID, '2026-10-18T13:00:00.000Z'), NexusError)
})

test('inferences are outputs, never premises for another agent', () => {
  const claims: Claim[] = [
    {
      id: 'cl_1',
      orgId: ORG_A,
      transactionId: TX,
      key: 'payment.prepay_rate',
      label: '预付款比例',
      value: '10%',
      numeric: 0.1,
      unit: null,
      status: 'confirmed',
      source: { kind: 'contract' },
      asOf: '2026-10-18',
      visibility: 'internal',
      supersededById: null,
      confirmedBy: null,
      confirmedAt: null
    },
    {
      id: 'cl_2',
      orgId: ORG_A,
      transactionId: TX,
      key: 'cash.gap',
      label: '资金缺口',
      value: '¥342,000',
      numeric: 342_000,
      unit: null,
      status: 'inferred',
      source: { kind: 'agent' },
      asOf: '2026-10-18',
      visibility: 'internal',
      supersededById: null,
      confirmedBy: null,
      confirmedAt: null
    }
  ]
  const { premises, excluded } = selectPremises(claims)
  assert.deepEqual(premises.map((c) => c.id), ['cl_1'])
  assert.deepEqual(excluded.map((c) => c.id), ['cl_2'])
})

test('approval writes a trail, keeps evidence as-is, and refuses a stale draft', async () => {
  const db = scenario()
  const result = await runOrchestrator({
    db,
    userId: DEFAULT_USER_ID,
    transactionId: TX,
    llm: NO_LLM,
    now: '2026-10-18T10:00:00.000Z',
    makeId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`
  })
  const proposal = result.proposal!
  db.claims.push(...result.claims)
  db.proposals.push(proposal)

  // A version saved after the draft was written invalidates it (here: terms walked back).
  db.versions.push(version(3, TERMS_A))
  assert.throws(
    () =>
      approveProposal({ db, proposalId: proposal.id, userId: DEFAULT_USER_ID, at: '2026-10-18T11:00:00.000Z' }),
    NexusError
  )

  // Re-run against the current version, then approve.
  const fresh = await runOrchestrator({
    db,
    userId: DEFAULT_USER_ID,
    transactionId: TX,
    llm: NO_LLM,
    now: '2026-10-18T11:00:00.000Z',
    makeId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`
  })
  const p2 = fresh.proposal!
  db.claims.push(...fresh.claims)
  db.proposals.push(p2)

  const statusBefore = new Map(db.claims.map((c) => [c.id, c.status]))
  const approved = approveProposal({ db, proposalId: p2.id, userId: DEFAULT_USER_ID, at: '2026-10-18T11:30:00.000Z' })
  assert.equal(approved.proposal.status, 'approved')
  assert.ok(approved.claims.length > 0)
  // Adopting the plan must not have changed the epistemic status of anything it cited.
  for (const c of db.claims) assert.equal(c.status, statusBefore.get(c.id), `claim ${c.key} changed status on approval`)
  assert.equal(db.activities.filter((a) => a.type === 'proposal_approved').length, 1)

  assert.throws(
    () => approveProposal({ db, proposalId: p2.id, userId: DEFAULT_USER_ID, at: '2026-10-18T12:00:00.000Z' }),
    NexusError
  )

  const rejected = rejectProposal({ db, proposalId: proposal.id, userId: DEFAULT_USER_ID, at: '2026-10-18T12:00:00.000Z' })
  assert.equal(rejected.status, 'rejected')
})

test('re-running the graph on unchanged terms does not pile up identical drafts', async () => {
  const db = scenario()
  db.proposals.length = 0 // start from an empty review queue; the demo ships one
  const run = (): Promise<Awaited<ReturnType<typeof runOrchestrator>>> =>
    runOrchestrator({
      db,
      userId: DEFAULT_USER_ID,
      transactionId: TX,
      llm: NO_LLM,
      now: '2026-10-18T10:00:00.000Z',
      makeId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`
    })
  const first = await run()
  assert.equal(isDuplicateProposal(db, first.proposal!), false)
  db.proposals.push(first.proposal!)

  // Same transaction, still undecided: a second run is a refresh, not a second card.
  const second = await run()
  assert.equal(isDuplicateProposal(db, second.proposal!), true)

  // Decided drafts do not block a new one after the situation changed.
  db.proposals.find((p) => p.id === first.proposal!.id)!.status = 'rejected'
  assert.equal(isDuplicateProposal(db, second.proposal!), false)
})

test('"no model configured" is a build fact, not advice shown to the user', async () => {
  const db = scenario()
  const result = await runOrchestrator({
    db,
    userId: DEFAULT_USER_ID,
    transactionId: TX,
    llm: null,
    now: '2026-10-18T10:00:00.000Z'
  })
  assert.ok(result.proposal, 'the deterministic finance step alone should still produce advice')
  assert.ok(!result.proposal!.rationale.includes('未接入模型'))
  assert.ok(result.briefs.some((b) => b.findings.includes('未接入模型，跳过该专业视角。')))
})

test('the shipped demo contains a worked example in the review queue', () => {
  const db = createSeedDatabase()
  const view = buildViewState(db, DEFAULT_USER_ID)
  const pending = view.proposals.filter((p) => p.status === 'pending')
  assert.equal(pending.length, 1)
  // Every piece of evidence it cites must be visible to the person asked to approve it.
  const { missing } = claimsForProposal(view.claims, pending[0])
  assert.deepEqual(missing, [])
  assert.ok(view.claims.some((c) => c.status === 'confirmed'))
  assert.ok(view.claims.some((c) => c.status === 'inferred'))
})

test('a user without access to the transaction cannot run the graph', async () => {
  const db = scenario()
  await assert.rejects(
    () =>
      runOrchestrator({
        db,
        userId: 'nobody',
        transactionId: TX,
        llm: null,
        now: '2026-10-18T10:00:00.000Z'
      }),
    NexusError
  )
})
