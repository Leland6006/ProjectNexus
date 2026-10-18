import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimAuthorLabel,
  claimValue,
  claimsForProposal,
  isStaleProposal,
  pendingCount,
  sortClaimsByStatus,
  sortForReview,
  unconfirmedClaims
} from '../src/shared/proposalView.ts'
import type { Claim, ContractVersion, Proposal } from '../src/shared/types.ts'

function claim(over: Partial<Claim> & { id: string }): Claim {
  return {
    orgId: 'org_a',
    transactionId: 'tx_1',
    key: 'cash.gap',
    label: '预计资金缺口',
    value: '¥10,000',
    numeric: 10_000,
    unit: 'CNY',
    status: 'confirmed',
    source: { kind: 'agent', ref: 'finance' },
    asOf: '2026-10-18T00:00:00.000Z',
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null,
    ...over
  }
}

function proposal(over: Partial<Proposal> & { id: string }): Proposal {
  return {
    transactionId: 'tx_1',
    contractId: 'ct_1',
    orgId: 'org_a',
    title: '提高预付款比例',
    rationale: '',
    actions: [],
    claimIds: [],
    eventId: null,
    status: 'pending',
    createdBy: 'agent:main',
    createdAt: '2026-10-18T00:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    baseVersionId: 'ver_2',
    ...over
  }
}

function version(id: string, number: number): ContractVersion {
  return { id, contractId: 'ct_1', number, label: '', note: '', clauses: [], paymentTerms: null, authorId: 'u', createdAt: '' }
}

test('pending count only counts drafts awaiting a person', () => {
  assert.equal(
    pendingCount([proposal({ id: 'p1' }), proposal({ id: 'p2', status: 'approved' }), proposal({ id: 'p3', status: 'rejected' })]),
    1
  )
})

test('review order puts pending first, newest first within each group', () => {
  const out = sortForReview([
    proposal({ id: 'old_pending', createdAt: '2026-01-01T00:00:00.000Z' }),
    proposal({ id: 'approved', status: 'approved', createdAt: '2026-03-01T00:00:00.000Z' }),
    proposal({ id: 'new_pending', createdAt: '2026-02-01T00:00:00.000Z' })
  ])
  assert.deepEqual(
    out.map((p) => p.id),
    ['new_pending', 'old_pending', 'approved']
  )
})

test('a draft is stale once a newer version exists', () => {
  const versions = [version('ver_1', 1), version('ver_2', 2)]
  assert.equal(isStaleProposal(versions, proposal({ id: 'p', baseVersionId: 'ver_2' })), false)
  assert.equal(isStaleProposal(versions, proposal({ id: 'p', baseVersionId: 'ver_1' })), true)
  assert.equal(isStaleProposal([...versions, version('ver_3', 3)], proposal({ id: 'p', baseVersionId: 'ver_2' })), true)
})

test('a draft without a contract is never stale', () => {
  assert.equal(isStaleProposal([version('ver_1', 1)], proposal({ id: 'p', contractId: null, baseVersionId: null })), false)
})

test('evidence is returned in the order the draft cites it', () => {
  const a = claim({ id: 'c1' })
  const b = claim({ id: 'c2', key: 'payment.prepay_amount' })
  const { found, missing } = claimsForProposal([a, b], proposal({ id: 'p', claimIds: ['c2', 'c1', 'c9'] }))
  assert.deepEqual(
    found.map((c) => c.id),
    ['c2', 'c1']
  )
  assert.deepEqual(missing, ['c9'])
})

test('claims sort facts before inferences before recommendations', () => {
  const out = sortClaimsByStatus([
    claim({ id: 'rec', status: 'recommended' }),
    claim({ id: 'inf', status: 'inferred' }),
    claim({ id: 'con', status: 'confirmed' })
  ])
  assert.deepEqual(
    out.map((c) => c.id),
    ['con', 'inf', 'rec']
  )
})

test('the confirmation queue excludes facts and superseded records', () => {
  const out = unconfirmedClaims([
    claim({ id: 'con', status: 'confirmed' }),
    claim({ id: 'inf', status: 'inferred' }),
    claim({ id: 'old', status: 'inferred', supersededById: 'inf' })
  ])
  assert.deepEqual(
    out.map((c) => c.id),
    ['inf']
  )
})

test('agent sources render as the specialist that produced them', () => {
  assert.equal(claimAuthorLabel(claim({ id: 'c', source: { kind: 'agent', ref: 'legal' } })), '法务 Agent')
  assert.equal(claimAuthorLabel(claim({ id: 'c', source: { kind: 'contract', ref: 'ct_1' } })), '合同')
})

test('numeric claims keep their unit in display', () => {
  assert.equal(claimValue(claim({ id: 'c' })), '¥10,000 CNY')
  assert.equal(claimValue(claim({ id: 'c', unit: null })), '¥10,000')
})
