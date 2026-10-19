// Round 1 framework rules: conversations, migration to v3, briefing, and the
// "adopting a plan is not confirming its facts" rule.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionItems, todayBriefing } from '../src/shared/briefing.ts'
import { NOT_CONNECTED_NOTICE, conversationTitle, searchConversations, type NexusRuntime } from '../src/shared/chat.ts'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/shared/migrations.ts'
import { approveProposal } from '../src/shared/orchestrator.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'
import { createSession, handleCall, setRuntime } from '../src/main/handlers.ts'
import type { Database } from '../src/shared/types.ts'

const AT = '2026-10-18T12:00:00.000Z'

function session(db: Database = createSeedDatabase()) {
  let changes = 0
  const s = createSession(db, DEFAULT_USER_ID, () => changes++)
  return { db, s, changes: () => changes }
}

// ---------- approval no longer promotes ----------

test('adopting the demo proposal keeps forecasts as forecasts and recommendations as recommendations', () => {
  const db = createSeedDatabase()
  const pending = db.proposals.find((p) => p.status === 'pending')!
  const before = new Map(db.claims.map((c) => [c.id, { status: c.status, confirmedBy: c.confirmedBy }]))
  assert.ok([...before.values()].some((c) => c.status === 'inferred'), 'demo should cite at least one inference')
  assert.ok([...before.values()].some((c) => c.status === 'recommended'), 'demo should cite at least one recommendation')

  approveProposal({ db, proposalId: pending.id, userId: DEFAULT_USER_ID, at: AT })

  for (const c of db.claims) {
    assert.deepEqual({ status: c.status, confirmedBy: c.confirmedBy }, before.get(c.id), `${c.key} was changed by approval`)
  }
  assert.equal(db.proposals.find((p) => p.id === pending.id)!.status, 'approved')
})

test('approval through IPC leaves claims untouched; explicit confirmClaim still works', async () => {
  const { db, s } = session()
  const pending = db.proposals.find((p) => p.status === 'pending')!
  const gap = db.claims.find((c) => c.key === 'cash.gap')!
  assert.equal(gap.status, 'inferred')

  assert.equal((await handleCall(s, 'approveProposal', [pending.id])).ok, true)
  assert.equal(gap.status, 'inferred')

  assert.equal((await handleCall(s, 'confirmClaim', [gap.id])).ok, true)
  assert.equal(gap.status, 'confirmed')
  assert.equal(gap.confirmedBy, DEFAULT_USER_ID)
})

// ---------- conversations ----------

test('starting a conversation stores the message and an honest not-connected notice', async () => {
  const { db, s } = session()
  const claimsBefore = JSON.stringify(db.claims)
  const r = await handleCall(s, 'startConversation', ['最近公司需要关注什么？'])
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.state.conversations.length, 1)
  const conv = r.state.conversations[0]
  assert.equal(conv.title, '最近公司需要关注什么？')
  const msgs = r.state.chatMessages.filter((m) => m.conversationId === conv.id)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'system'])
  assert.equal(msgs[1].body, NOT_CONNECTED_NOTICE)
  assert.equal(msgs[1].runtime, 'none')
  // No assistant message is fabricated, and nothing became company memory.
  assert.ok(!msgs.some((m) => m.role === 'assistant'))
  assert.equal(JSON.stringify(db.claims), claimsBefore)
})

test('conversations are private to the account, even inside the same company', async () => {
  const { s } = session()
  const started = await handleCall(s, 'startConversation', ['内部问题'])
  assert.ok(started.ok)
  const convId = started.ok ? started.state.conversations[0].id : ''

  // Colleague in the same company (启明 法务).
  const colleague = await handleCall(s, 'switchUser', ['u_a_legal'])
  assert.ok(colleague.ok)
  if (colleague.ok) {
    assert.equal(colleague.state.conversations.length, 0)
    assert.equal(colleague.state.chatMessages.length, 0)
  }
  const write = await handleCall(s, 'sendChatMessage', [convId, '我也想看'])
  assert.equal(write.ok, false)
  if (!write.ok) assert.equal(write.code, 'NOT_FOUND')
  const rename = await handleCall(s, 'renameConversation', [convId, '改名'])
  assert.equal(rename.ok, false)

  // The other company.
  const other = await handleCall(s, 'switchUser', ['u_b_biz'])
  assert.ok(other.ok && other.state.conversations.length === 0)

  // Back to the owner: still there.
  const back = await handleCall(s, 'switchUser', [DEFAULT_USER_ID])
  assert.ok(back.ok && back.state.conversations.some((c) => c.id === convId))
})

test('send, rename and validation', async () => {
  const { s } = session()
  const r = await handleCall(s, 'startConversation', ['第一条'])
  const id = r.ok ? r.state.conversations[0].id : ''
  const r2 = await handleCall(s, 'sendChatMessage', [id, '第二条'])
  assert.ok(r2.ok)
  if (r2.ok) assert.equal(r2.state.chatMessages.filter((m) => m.conversationId === id).length, 4)

  const renamed = await handleCall(s, 'renameConversation', [id, '采购事项'])
  assert.ok(renamed.ok && renamed.state.conversations[0].title === '采购事项')

  for (const bad of [
    ['startConversation', ['   ']],
    ['sendChatMessage', [id, '']],
    ['sendChatMessage', [id, 'x'.repeat(5000)]],
    ['renameConversation', [id, '']],
    ['sendChatMessage', ['cv_missing', 'hi']]
  ] as const) {
    const res = await handleCall(s, bad[0], [...bad[1]])
    assert.equal(res.ok, false, `${bad[0]} should reject ${JSON.stringify(bad[1]).slice(0, 40)}`)
  }
})

test('a connected runtime reply is stored; a reply that arrives after an account switch is dropped', async () => {
  const { s } = session()
  let release!: () => void
  const slow: NexusRuntime = {
    id: 'test',
    connected: true,
    reply: () => new Promise((resolve) => (release = () => resolve({ role: 'assistant', body: '测试回复', runtime: 'test' })))
  }
  setRuntime(slow)
  try {
    const pending = handleCall(s, 'startConversation', ['问题'])
    await new Promise((r) => setImmediate(r))
    s.currentUserId = 'u_b_biz' // simulate a switch while waiting
    release()
    await pending
    const ownerMsgs = s.service.db.chatMessages
    assert.ok(!ownerMsgs.some((m) => m.role === 'assistant'), 'late reply must not be written')

    s.currentUserId = DEFAULT_USER_ID
    const ok = handleCall(s, 'startConversation', ['再问一次'])
    await new Promise((r) => setImmediate(r))
    release()
    const res = await ok
    assert.ok(res.ok && res.state.chatMessages.some((m) => m.role === 'assistant' && m.runtime === 'test'))
  } finally {
    setRuntime(null)
  }
})

test('conversations survive the persistence round trip and migrate from v2', () => {
  const db = createSeedDatabase()
  const v2 = JSON.parse(JSON.stringify(db)) as Record<string, unknown>
  delete v2.conversations
  delete v2.chatMessages
  v2.schemaVersion = 2
  const r = migrateDatabase(v2)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.fromVersion, 2)
  assert.equal(r.db.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(r.db.conversations, [])
  assert.deepEqual(r.db.chatMessages, [])
  // Nothing that existed before was lost.
  assert.equal(r.db.transactions.length, db.transactions.length)
  assert.equal(r.db.claims.length, db.claims.length)
  assert.equal(r.db.proposals.length, db.proposals.length)
})

test('chat helpers', () => {
  assert.equal(conversationTitle('  评估  一笔\n新业务 '), '评估 一笔 新业务')
  assert.equal(conversationTitle(''), '新对话')
  assert.ok(conversationTitle('长'.repeat(40)).endsWith('…'))
  const list = [
    { id: 'a', ownerUserId: 'u', orgId: 'o', title: '开票事项', createdAt: AT, updatedAt: '2026-10-18T10:00:00.000Z' },
    { id: 'b', ownerUserId: 'u', orgId: 'o', title: '采购评估', createdAt: AT, updatedAt: '2026-10-18T11:00:00.000Z' }
  ]
  assert.deepEqual(searchConversations(list, '').map((c) => c.id), ['b', 'a'])
  assert.deepEqual(searchConversations(list, '开票').map((c) => c.id), ['a'])
})

// ---------- briefing ----------

test('briefing only lists sourced items the account can see, at most three on the home page', () => {
  const db = createSeedDatabase()
  const now = new Date('2026-10-18T09:00:00')
  const a = buildViewState(db, DEFAULT_USER_ID)
  const items = attentionItems(a, now)
  assert.ok(items.length > 0)
  assert.ok(items.every((i) => i.source.length > 0))
  assert.ok(items.some((i) => i.kind === 'decision'))
  assert.ok(items.some((i) => i.kind === 'suggestion'))
  assert.ok(todayBriefing(a, now).length <= 3)

  // External counsel never sees proposals (internal financial content), so no decisions.
  const counsel = buildViewState(db, 'u_a_counsel')
  assert.ok(!attentionItems(counsel, now).some((i) => i.kind === 'decision'))

  // An account with nothing visible gets an empty list, not invented status.
  const empty = buildViewState({ ...db, transactions: [], proposals: [], milestones: [], suggestions: [] }, DEFAULT_USER_ID)
  assert.deepEqual(attentionItems(empty, now), [])
})

test('a suggestion my own side made is not listed as needing my action', () => {
  const db = createSeedDatabase()
  const now = new Date('2026-10-18T09:00:00')
  const b = buildViewState(db, 'u_b_biz')
  // sg_3 was raised by 远航 (org B); B must not be asked to answer its own proposal.
  assert.ok(!attentionItems(b, now).some((i) => i.id === 'suggestion:sg_3'))
  const a = buildViewState(db, DEFAULT_USER_ID)
  assert.ok(attentionItems(a, now).some((i) => i.id === 'suggestion:sg_3'))
})
