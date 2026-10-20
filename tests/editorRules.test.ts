import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canConfirmFinal,
  clauseBadges,
  newClause,
  previousVersion,
  replyVisibility,
  sortVersionsDesc,
  visibilityOptions
} from '../src/shared/editorRules.ts'
import type { Comment, Suggestion } from '../src/shared/types.ts'

const comment = (
  id: string,
  clauseId: string,
  visibility: Comment['visibility'] = 'shared'
): Comment => ({
  id,
  contractId: 'ct_1',
  clauseId,
  parentId: null,
  authorId: 'u_a_biz',
  orgId: 'org_qiming',
  body: 'x',
  visibility,
  createdAt: '2026-10-01T00:00:00.000Z'
})

const suggestion = (id: string, clauseId: string, status: Suggestion['status']): Suggestion => ({
  id,
  contractId: 'ct_1',
  clauseId,
  authorId: 'u_b_biz',
  orgId: 'org_yuanhang',
  originalBody: '<p>a</p>',
  proposedBody: '<p>b</p>',
  reason: 'r',
  status,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z'
})

test('a new clause is numbered after the existing ones', () => {
  let n = 0
  const makeId = () => `cl_${++n}`
  const clauses = [
    { id: 'cl_0', title: '第一条 总则', body: '<p></p>' },
    { id: 'cl_1', title: '第二条 价款', body: '<p></p>' }
  ]
  assert.deepEqual(newClause(clauses, makeId), {
    id: 'cl_1',
    title: '第3条 新条款',
    body: '<p></p>'
  })
})

test('clause counters ignore other contracts and resolved suggestions', () => {
  const comments = [comment('c1', 'cl_a'), comment('c2', 'cl_a'), comment('c3', 'cl_b')]
  const suggestions = [suggestion('s1', 'cl_a', 'pending'), suggestion('s2', 'cl_a', 'accepted')]
  assert.deepEqual(clauseBadges(comments, suggestions, 'ct_1', 'cl_a'), {
    comments: 2,
    pendingSuggestions: 1
  })
  assert.deepEqual(clauseBadges(comments, suggestions, 'ct_1', 'cl_b'), {
    comments: 1,
    pendingSuggestions: 0
  })
  assert.deepEqual(clauseBadges(comments, suggestions, 'ct_other', 'cl_a'), {
    comments: 0,
    pendingSuggestions: 0
  })
})

test('external counsel may only write for their engaging organisation', () => {
  assert.deepEqual(visibilityOptions({ isCounsel: true, canShare: true }), ['counsel'])
})

test('shared comments require a shared contract', () => {
  assert.deepEqual(visibilityOptions({ isCounsel: false, canShare: false }), [
    'internal',
    'counsel'
  ])
  assert.deepEqual(visibilityOptions({ isCounsel: false, canShare: true }), [
    'shared',
    'internal',
    'counsel'
  ])
})

test('a reply cannot widen the audience of an internal thread', () => {
  assert.deepEqual(
    visibilityOptions({ isCounsel: false, canShare: true, replyAudience: 'internal' }),
    ['internal', 'counsel']
  )
  assert.deepEqual(
    visibilityOptions({ isCounsel: false, canShare: true, replyAudience: 'shared' }),
    ['shared', 'internal', 'counsel']
  )
})

test('replyVisibility clamps a shared reply onto a narrower thread', () => {
  assert.equal(replyVisibility('internal', 'shared'), 'internal')
  assert.equal(replyVisibility('counsel', 'shared'), 'counsel')
  assert.equal(replyVisibility('shared', 'shared'), 'shared')
  assert.equal(replyVisibility(null, 'internal'), 'internal')
})

test('final confirmation needs a shared, unlocked, saved latest version', () => {
  const base = {
    isParty: true,
    shared: true,
    locked: false,
    hasLatest: true,
    alreadyConfirmed: false,
    dirty: false
  }
  assert.equal(canConfirmFinal(base), true)
  assert.equal(
    canConfirmFinal({ ...base, dirty: true }),
    false,
    'unsaved edits must be saved first'
  )
  assert.equal(canConfirmFinal({ ...base, alreadyConfirmed: true }), false)
  assert.equal(canConfirmFinal({ ...base, shared: false }), false)
  assert.equal(canConfirmFinal({ ...base, locked: true }), false)
  assert.equal(canConfirmFinal({ ...base, hasLatest: false }), false)
  assert.equal(
    canConfirmFinal({ ...base, isParty: false }),
    false,
    'external counsel cannot confirm'
  )
})

test('versions are sorted newest first without mutating the input', () => {
  const versions = [
    {
      id: 'v1',
      contractId: 'ct_1',
      number: 1,
      label: 'a',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    },
    {
      id: 'v3',
      contractId: 'ct_1',
      number: 3,
      label: 'c',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    },
    {
      id: 'v2',
      contractId: 'ct_1',
      number: 2,
      label: 'b',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    }
  ]
  const sorted = sortVersionsDesc(versions)
  assert.deepEqual(
    sorted.map((v) => v.number),
    [3, 2, 1]
  )
  assert.deepEqual(
    versions.map((v) => v.number),
    [1, 3, 2]
  )
})

test('previousVersion finds the immediately preceding version', () => {
  const versions = sortVersionsDesc([
    {
      id: 'v1',
      contractId: 'ct_1',
      number: 1,
      label: 'a',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    },
    {
      id: 'v2',
      contractId: 'ct_1',
      number: 2,
      label: 'b',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    },
    {
      id: 'v3',
      contractId: 'ct_1',
      number: 3,
      label: 'c',
      note: '',
      clauses: [],
      paymentTerms: null,
      authorId: 'u',
      createdAt: 'x'
    }
  ])
  assert.equal(previousVersion(versions, versions[0])?.number, 2)
  assert.equal(previousVersion(versions, versions[1])?.number, 1)
  assert.equal(previousVersion(versions, versions[2]), undefined)
  assert.equal(previousVersion(versions, undefined), undefined)
})
