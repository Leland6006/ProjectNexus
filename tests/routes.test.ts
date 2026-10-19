import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOME,
  attentionRoute,
  defaultRoute,
  isContractRoute,
  reconcileRoute,
  rememberable,
  type Route,
  type VisibleIds
} from '../src/renderer/src/routes.ts'

const visible: VisibleIds = { conversations: ['cv_1'], transactions: ['tx_1'], contracts: ['ct_1'], counterparties: ['org_b'] }

test('the app starts on a fresh Nexus conversation', () => {
  assert.deepEqual(HOME, { module: 'nexus', conversationId: null })
  assert.deepEqual(defaultRoute('nexus'), HOME)
})

test('routes to objects the account can still see are kept', () => {
  const keep: Route[] = [
    { module: 'nexus', conversationId: 'cv_1' },
    { module: 'business', view: 'project', transactionId: 'tx_1', tab: 'money' },
    { module: 'business', view: 'contract', contractId: 'ct_1' },
    { module: 'business', view: 'counterparty', orgId: 'org_b' },
    { module: 'actions', view: 'decisions' }
  ]
  for (const r of keep) assert.equal(reconcileRoute(r, visible), r)
})

test('routes to objects that are no longer visible fall back to the module default', () => {
  assert.deepEqual(reconcileRoute({ module: 'nexus', conversationId: 'cv_other' }, visible), HOME)
  assert.deepEqual(reconcileRoute({ module: 'business', view: 'project', transactionId: 'tx_x', tab: 'overview' }, visible), defaultRoute('business'))
  assert.deepEqual(reconcileRoute({ module: 'business', view: 'contract', contractId: 'ct_x' }, visible), defaultRoute('business'))
  assert.deepEqual(reconcileRoute({ module: 'business', view: 'counterparty', orgId: 'org_x' }, visible), defaultRoute('business'))
})

test('one-shot flags are not remembered when switching modules', () => {
  assert.deepEqual(rememberable({ module: 'business', view: 'all', create: true }), { module: 'business', view: 'all' })
  const project: Route = { module: 'business', view: 'project', transactionId: 'tx_1', tab: 'collab' }
  assert.equal(rememberable(project), project)
})

test('attention items open where they are handled', () => {
  assert.deepEqual(attentionRoute({ kind: 'decision', transactionId: 'tx_1', contractId: 'ct_1' }), { module: 'actions', view: 'decisions' })
  assert.deepEqual(attentionRoute({ kind: 'suggestion', transactionId: 'tx_1', contractId: 'ct_1' }), { module: 'business', view: 'contract', contractId: 'ct_1' })
  assert.deepEqual(attentionRoute({ kind: 'milestone', transactionId: 'tx_1', contractId: null }), {
    module: 'business',
    view: 'project',
    transactionId: 'tx_1',
    tab: 'performance'
  })
})

test('only the contract editor counts as a contract route', () => {
  assert.equal(isContractRoute({ module: 'business', view: 'contract', contractId: 'ct_1' }), true)
  assert.equal(isContractRoute({ module: 'business', view: 'contracts' }), false)
})
