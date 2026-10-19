import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, handleCall, runAgentsFor, setLlmClient } from '../src/main/handlers.ts'
import { JsonStore } from '../src/main/store.ts'
import { approveProposal, rejectProposal, runOrchestrator } from '../src/shared/orchestrator.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'

const at = '2026-10-19T09:00:00.000Z'
const proposalId = 'pp_demo_prepay'
const transactionId = 'tx_equip'

for (const userId of ['u_b_biz', 'u_c_biz', 'u_a_counsel', 'missing']) {
  test(`${userId} cannot approve or reject another enterprise's internal proposal`, () => {
    const db = createSeedDatabase()
    const before = JSON.stringify(db)
    assert.throws(() => approveProposal({ db, proposalId, userId, at }))
    assert.throws(() => rejectProposal({ db, proposalId, userId, at }))
    assert.equal(JSON.stringify(db), before)
  })
}

for (const invalid of ['missing', 'superseded', 'other-org'] as const) {
  test(`approval rejects ${invalid} evidence before changing anything`, () => {
    const db = createSeedDatabase()
    const proposal = db.proposals.find((p) => p.id === proposalId)!
    if (invalid === 'missing') proposal.claimIds.push('absent')
    else {
      const claim = db.claims.find((c) => c.id === proposal.claimIds[0])!
      if (invalid === 'superseded') claim.supersededById = 'newer'
      else claim.orgId = 'org_yuanhang'
    }
    const before = JSON.stringify(db)
    assert.throws(() => approveProposal({ db, proposalId, userId: DEFAULT_USER_ID, at }))
    assert.equal(JSON.stringify(db), before)
  })
}

for (const method of ['approveProposal', 'rejectProposal']) {
  test(`${method} persists through a real store reload`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-review-'))
    try {
      const store = new JsonStore(dir)
      const loaded = store.load()
      let changes = 0
      const session = createSession(loaded.db, DEFAULT_USER_ID, (s) => {
        changes++
        store.save({ db: s.service.db, currentUserId: s.currentUserId })
      })
      const result = await handleCall(session, method, [proposalId])
      assert.equal(result.ok, true)
      assert.equal(changes, 1)
      store.flush()
      const reloaded = new JsonStore(dir).load()
      assert.equal(reloaded.db.proposals.find((p) => p.id === proposalId)?.status,
        method === 'approveProposal' ? 'approved' : 'rejected')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('external counsel cannot read or regenerate internal financial proposals', async () => {
  const db = createSeedDatabase()
  assert.equal(buildViewState(db, 'u_a_counsel').proposals.length, 0)
  let modelCalls = 0
  await assert.rejects(runOrchestrator({ db, userId: 'u_a_counsel', transactionId, now: at,
    llm: { complete: async () => { modelCalls++; return '' } } }))
  assert.equal(modelCalls, 0)
})

test('an unshared contract and its terms do not enter counterparty analysis', async () => {
  const db = createSeedDatabase()
  db.contracts.find((c) => c.id === 'ct_equip')!.sharedWithCounterparty = false
  const result = await runOrchestrator({ db, userId: 'u_b_biz', transactionId, now: at })
  assert.equal(result.event, null)
  assert.equal(result.proposal, null)
  assert.equal(result.claims.length, 0)
})

test('pre-sharing version history does not trigger a counterparty event', async () => {
  const db = createSeedDatabase()
  db.contracts.find((c) => c.id === 'ct_equip')!.sharedAt = '2099-01-01T00:00:00.000Z'
  const result = await runOrchestrator({ db, userId: 'u_b_biz', transactionId, now: at })
  assert.equal(result.event, null)
  assert.equal(result.claims.length, 0)
})

test('analysis freezes its version before awaiting a model', async () => {
  const db = createSeedDatabase()
  const versions = db.versions.filter((v) => v.contractId === 'ct_equip').sort((a, b) => a.number - b.number)
  const baseline = versions.at(-1)!
  let calls = 0
  const result = await runOrchestrator({ db, userId: DEFAULT_USER_ID, transactionId, now: at,
    llm: { complete: async () => {
      if (calls++ === 0) {
        db.versions.push({ ...structuredClone(baseline), id: 'new-version', number: 100 })
        db.contracts.find((c) => c.id === 'ct_equip')!.paymentTerms!.prepayRate = 0.5
      }
      return '- 建议分期收款'
    } } })
  assert.equal(result.proposal?.baseVersionId, baseline.id)
  assert.equal(result.claims.find((c) => c.key === 'payment.prepay_amount')?.numeric, 128_000)
})

test('a delayed analysis cannot write results after source data changes', async () => {
  const db = createSeedDatabase()
  const beforeClaims = structuredClone(db.claims)
  const beforeProposals = structuredClone(db.proposals)
  let changes = 0
  const session = createSession(db, DEFAULT_USER_ID, () => { changes++ })
  let calls = 0
  setLlmClient({ complete: async () => {
    if (calls++ === 0) db.cashAccounts[0].openingBalance += 1
    return '- 需要重新评估'
  } })
  try {
    const result = await handleCall(session, 'runAgents', [transactionId])
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'CONFLICT')
    assert.deepEqual(db.claims, beforeClaims)
    assert.deepEqual(db.proposals, beforeProposals)
    assert.equal(changes, 0)
  } finally { setLlmClient(null) }
})

test('proposal evidence uses the actual retained claim ID when an inference is ignored', async () => {
  const db = createSeedDatabase()
  const existing = db.claims.find((c) => c.key === 'cash.gap')!
  existing.status = 'confirmed'
  const session = createSession(db, DEFAULT_USER_ID, () => {})
  setLlmClient(null)
  await runAgentsFor(session, transactionId)
  const proposal = db.proposals.find((p) => p.transactionId === transactionId && p.status === 'pending')!
  assert.ok(proposal.claimIds.includes(existing.id))
  assert.ok(proposal.claimIds.every((id) => db.claims.some((c) => c.id === id && !c.supersededById)))
})

test('newer analysis wins when two runs overlap', async () => {
  const db = createSeedDatabase()
  const session = createSession(db, DEFAULT_USER_ID, () => {})
  let release!: (value: string) => void
  let calls = 0
  setLlmClient({ complete: async () => {
    if (calls++ === 0) return new Promise<string>((resolve) => { release = resolve })
    return '- 新分析结果'
  } })
  try {
    const oldRun = handleCall(session, 'runAgents', [transactionId])
    assert.equal((await handleCall(session, 'runAgents', [transactionId])).ok, true)
    release('- 旧分析结果')
    const oldResult = await oldRun
    assert.equal(oldResult.ok, false)
    if (!oldResult.ok) assert.equal(oldResult.code, 'CONFLICT')
    const pending = db.proposals.filter((p) => p.transactionId === transactionId && p.status === 'pending')
    assert.equal(pending.length, 1)
    assert.ok(!pending[0].rationale.includes('旧分析结果'))
  } finally { setLlmClient(null) }
})
