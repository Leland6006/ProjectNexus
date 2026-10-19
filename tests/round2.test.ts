import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createSeedDatabase, DEFAULT_USER_ID, ORG_A, ORG_B } from '../src/shared/seed.ts'
import { NexusService } from '../src/shared/service.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { projectForecast, queryBusiness } from '../src/shared/businessContext.ts'
import { approveProposal } from '../src/shared/orchestrator.ts'
import { isStaleProposal } from '../src/shared/proposalView.ts'
import { createSession, handleCall, setRuntime } from '../src/main/handlers.ts'
import { AiSettings, createDeepSeekRuntime, readCompletion, validateAiConfig } from '../src/main/ai.ts'
import { migrateDatabase, CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'

const profile = { industry: '软件服务', business: 'AI 应用开发', goal: '完成首笔订单', stage: '初创', teamSize: 1, region: '杭州' }
const seed = () => createSeedDatabase()
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')
}
const textChunk = (content: string) => ({ choices: [{ delta: { content } }] })

test('company data writes are validated and private even in demo directory', () => {
  const db = seed(), service = new NexusService(db)
  service.updateCompanyProfile(DEFAULT_USER_ID, profile)
  const a = buildViewState(db, DEFAULT_USER_ID, { demoDirectory: true })
  assert.equal(a.organizations.find((o) => o.id === ORG_A)?.profile?.goal, profile.goal)
  const b = buildViewState(db, 'u_b_biz', { demoDirectory: true })
  assert.equal(b.organizations.find((o) => o.id === ORG_A)?.profile, null)
  assert.equal(a.demoAccounts?.organizations.find((o) => o.id === ORG_A)?.profile, null)
  assert.throws(() => service.updateCompanyProfile('u_a_counsel', profile))
  assert.throws(() => service.updateCompanyProfile(DEFAULT_USER_ID, { ...profile, teamSize: -1 }))
  const before = JSON.stringify(db)
  assert.throws(() => service.saveCashAccount(DEFAULT_USER_ID, { label: '非法日期', openingBalance: 1, asOf: '2026-02-30' }))
  assert.throws(() => service.saveCashAccount(DEFAULT_USER_ID, { label: '非法金额', openingBalance: 0.001, asOf: '2026-10-19' }))
  assert.equal(JSON.stringify(db), before)
})

test('account and cost edit cannot target another organisation or a hidden project', () => {
  const db = seed(), service = new NexusService(db)
  assert.throws(() => service.saveCashAccount('u_b_biz', { id: 'cash_a', label: '越权', openingBalance: 1, asOf: '2026-10-19' }))
  assert.throws(() => service.saveCostItem('u_c_biz', { transactionId: 'tx_equip', name: '越权', amount: 1, dueDate: '2026-11-01', status: 'planned' }))
  assert.throws(() => service.saveCostItem('u_b_biz', { id: 'cost_1', transactionId: 'tx_equip', name: '越权', amount: 1, dueDate: '2026-11-01', status: 'planned' }))
  const c = service.saveCostItem(DEFAULT_USER_ID, { transactionId: 'tx_equip', name: '新成本', amount: 100, dueDate: '2026-11-15', status: 'committed' })
  assert.equal(c.visibility, 'internal')
  assert.ok(!buildViewState(db, 'u_b_biz').costItems.some((x) => x.id === c.id))
})

test('changing source data invalidates approval without pretending the user rejected a proposal', () => {
  const db = seed(), service = new NexusService(db)
  service.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '账户', openingBalance: 100, asOf: '2026-10-18' })
  const p = db.proposals[0]
  assert.equal(p.status, 'pending')
  assert.ok(isStaleProposal(db.versions, p))
  assert.throws(() => approveProposal({ db, proposalId: p.id, userId: DEFAULT_USER_ID, at: '2026-10-19' }))
})

test('project forecast respects payer direction, confirmed dates, paid costs and missing data', () => {
  const db = seed()
  const a = projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip')
  assert.ok(a.available)
  if (a.available) assert.equal(a.forecast.shortfall, 438000)
  db.costItems[0].status = 'paid'
  const paid = projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip')
  assert.ok(paid.available)
  if (paid.available) assert.equal(paid.forecast.outflows.some((x) => x.label === '核心传感器备货款'), false)
  db.contracts[0].paymentTerms!.payerOrgId = ORG_A
  const payer = projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip')
  assert.ok(payer.available)
  if (payer.available) { assert.equal(payer.forecast.inflows.length, 0); assert.ok(payer.forecast.outflows.some((x) => x.label === '预付款')) }
  db.cashAccounts = []
  const missing = projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip')
  assert.equal(missing.available, false)
  assert.ok(missing.missing.includes('现金余额与日期'))
})

test('different account snapshot dates and historic unverified payments prevent a forecast', () => {
  const db = seed()
  db.cashAccounts.push({ ...db.cashAccounts[0], id: 'cash_new', asOf: '2026-11-12' })
  assert.equal(projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip').available, false)
  db.cashAccounts[0].asOf = '2026-12-01'
  db.cashAccounts.pop()
  assert.equal(projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip').available, false)
})

test('read tools cannot inspect invisible projects or raw discussions', () => {
  const db = seed()
  const view = buildViewState(db, 'u_c_biz')
  assert.throws(() => queryBusiness(view, 'project_details', { transactionId: 'tx_equip' }))
  assert.throws(() => queryBusiness(view, 'write_anything', {}))
  const output = queryBusiness(buildViewState(db, DEFAULT_USER_ID), 'project_details', { transactionId: 'tx_equip' })
  assert.ok(!JSON.stringify(output).includes('originalBody'))
  assert.ok(output.references.some((r) => r.id === 'cash_a'))
})

test('schema v3 migration preserves business data and conversations', () => {
  const db = seed()
  db.schemaVersion = 3
  const old = JSON.stringify(db.transactions)
  const r = migrateDatabase(db)
  assert.ok(r.ok)
  assert.equal(db.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.equal(JSON.stringify(db.transactions), old)
  assert.deepEqual(db.conversations, [])
})

test('SSE handles Unicode chunk boundaries, tool fragments, disconnects and server errors', async () => {
  const wire = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'
  const bytes = new TextEncoder().encode(wire)
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() } })
  const deltas: string[] = []
  const answer = await readCompletion(new Response(stream), (s) => deltas.push(s))
  assert.equal(answer.content, '你好')
  assert.equal(deltas.at(-1), '你好')
  const calls = await readCompletion(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool1', function: { name: 'project_details', arguments: '{"transaction' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"tx_equip"}' } }] } }] }]))
  assert.equal(JSON.parse(calls.calls[0].function.arguments).transactionId, 'tx_equip')
  await assert.rejects(readCompletion(new Response('data: {"choices":[]}\n')), /连接中断/)
  await assert.rejects(readCompletion(new Response('', { status: 401 })), /API Key/)
})

test('real adapter protocol uses tools and refreshes new data without making network calls in tests', async () => {
  const db = seed()
  let calls = 0
  const sent: Record<string, unknown>[] = []
  const fakeFetch = (async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string))
    if (calls++ === 0) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'project_details', arguments: '{"transactionId":"tx_equip"}' } }] } }] }])
    return sse([textChunk('根据项目成本与余额，需要关注资金安排。')])
  }) as typeof fetch
  const runtime = createDeepSeekRuntime({ apiKey: 'test-key-12345', model: 'test-model' }, fakeFetch)
  const reply = await runtime.reply({ conversationId: 'c', userId: DEFAULT_USER_ID, text: '评估项目', view: buildViewState(db, DEFAULT_USER_ID) })
  assert.equal(calls, 2)
  assert.ok(reply.references?.some((r) => r.id === 'cost_1'))
  const messages = sent[1].messages as { role: string; content: string }[]
  assert.ok(messages.find((m) => m.role === 'tool')?.content.includes('438000'))
  assert.ok(!JSON.stringify(sent).includes('test-key-12345'))
})

test('key persistence uses supplied vault, never stores plaintext and clears independently of business data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ai-test-'))
  const secret = randomBytes(32), iv = randomBytes(16)
  const vault = { available: () => true, encrypt: (text: string) => { const c = createCipheriv('aes-256-cbc', secret, iv); return Buffer.concat([c.update(text), c.final()]) }, decrypt: (bytes: Buffer) => { const c = createDecipheriv('aes-256-cbc', secret, iv); return Buffer.concat([c.update(bytes), c.final()]).toString() } }
  try {
    const store = new AiSettings(dir, vault)
    store.save({ apiKey: 'never-store-plaintext', model: 'test-model' })
    assert.ok(!readFileSync(join(dir, 'ai-connection.enc')).includes('never-store-plaintext'))
    assert.equal(store.load()?.model, 'test-model')
    store.clear()
    assert.equal(store.load(), null)
    assert.throws(() => new AiSettings(dir, { ...vault, available: () => false }).save({ apiKey: 'never-store-plaintext', model: 'test-model' }))
    assert.throws(() => validateAiConfig({ apiKey: 'short', model: 'x' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cancel, concurrent sends, identity switch-back, and retry do not leak or duplicate messages', async () => {
  const db = seed(), session = createSession(db, DEFAULT_USER_ID, () => {})
  let finish!: () => void
  setRuntime({ id: 'test', connected: true, reply: async (req) => { await new Promise<void>((resolve) => { finish = resolve; req.signal?.addEventListener('abort', () => resolve(), { once: true }) }); return { role: 'assistant', runtime: 'test', body: '迟到的回答' } } })
  try {
    const run = handleCall(session, 'startConversation', ['原问题'])
    await new Promise((r) => setImmediate(r))
    const duplicate = await handleCall(session, 'startConversation', ['重复'])
    assert.equal(duplicate.ok, false)
    await handleCall(session, 'cancelChat', [])
    finish(); await run
    assert.equal(db.chatMessages.filter((m) => m.role === 'assistant').length, 0)
    assert.equal(db.chatMessages.filter((m) => m.role === 'user').length, 1)
    const retry = handleCall(session, 'retryChat', [db.conversations[0].id])
    await new Promise((r) => setImmediate(r))
    await handleCall(session, 'switchUser', ['u_b_biz'])
    await handleCall(session, 'switchUser', [DEFAULT_USER_ID])
    finish(); await retry
    assert.equal(db.chatMessages.filter((m) => m.role === 'assistant').length, 0)
    assert.equal(db.chatMessages.filter((m) => m.role === 'user').length, 1)
  } finally { setRuntime(null) }
})

test('chat profile proposals remain drafts until their owner confirms and cannot overwrite newer data', () => {
  const db = seed(), service = new NexusService(db)
  const { conversation } = service.startConversation(DEFAULT_USER_ID, '将目标改为完成首单')
  const result = queryBusiness(buildViewState(db, DEFAULT_USER_ID), 'propose_profile_update', { goal: '完成首单' })
  assert.equal(db.organizations.find((o) => o.id === ORG_A)?.profile, undefined)
  const reply = service.recordRuntimeReply(DEFAULT_USER_ID, conversation.id, { role: 'assistant', body: '请确认', runtime: 'test', profileUpdate: result.profileUpdate })
  assert.throws(() => service.confirmProfileUpdate('u_b_biz', reply.id))
  service.confirmProfileUpdate(DEFAULT_USER_ID, reply.id)
  assert.equal(db.organizations.find((o) => o.id === ORG_A)?.profile?.goal, '完成首单')
  assert.ok(reply.profileUpdate?.appliedAt)
  assert.throws(() => service.confirmProfileUpdate(DEFAULT_USER_ID, reply.id))
  const staleReply = service.recordRuntimeReply(DEFAULT_USER_ID, conversation.id, { role: 'assistant', body: '旧草稿', runtime: 'test', profileUpdate: result.profileUpdate })
  assert.throws(() => service.confirmProfileUpdate(DEFAULT_USER_ID, staleReply.id))
  assert.throws(() => queryBusiness(buildViewState(db, DEFAULT_USER_ID), 'propose_profile_update', { orgId: ORG_B }))
})

test('snapshot changes discard in-flight answers; only this conversation history reaches the runtime', async () => {
  const db = seed(), service = new NexusService(db)
  service.startConversation('u_b_biz', '另一企业的私密问题')
  const session = createSession(db, DEFAULT_USER_ID, () => {})
  let finish!: () => void
  setRuntime({ id: 'test', connected: true, reply: async (req) => {
    assert.equal(req.view?.demoAccounts, null)
    assert.deepEqual(req.view?.conversations, [])
    assert.ok(!JSON.stringify(req.history).includes('另一企业的私密问题'))
    await new Promise<void>((resolve) => { finish = resolve })
    return { role: 'assistant', runtime: 'test', body: '旧数据结论' }
  } })
  try {
    const run = handleCall(session, 'startConversation', ['评估我的公司'])
    await new Promise((r) => setImmediate(r))
    service.updateCompanyProfile(DEFAULT_USER_ID, profile)
    finish(); await run
    assert.ok(!db.chatMessages.some((m) => m.body === '旧数据结论'))
    assert.ok(db.chatMessages.some((m) => m.body.includes('数据已变化')))
  } finally { setRuntime(null) }
})

test('updated company data and chat evidence survive the actual JSON store reload', async () => {
  const { JsonStore } = await import('../src/main/store.ts')
  const dir = mkdtempSync(join(tmpdir(), 'nexus-round2-store-'))
  try {
    const store = new JsonStore(dir)
    const { db } = store.load()
    const service = new NexusService(db)
    service.updateCompanyProfile(DEFAULT_USER_ID, profile)
    service.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '账户', openingBalance: 120000, asOf: '2026-10-19' })
    const { conversation } = service.startConversation(DEFAULT_USER_ID, '测试来源持久化')
    service.recordRuntimeReply(DEFAULT_USER_ID, conversation.id, { role: 'assistant', body: '回答', runtime: 'test', references: [{ id: 'cash_a', label: '账户', detail: '2026-10-19' }] })
    store.save({ db, currentUserId: DEFAULT_USER_ID }); store.flush()
    const loaded = new JsonStore(dir).load()
    assert.equal(loaded.db.organizations.find((o) => o.id === ORG_A)?.profile?.business, profile.business)
    assert.equal(loaded.db.cashAccounts[0].openingBalance, 120000)
    assert.equal(loaded.db.chatMessages.at(-1)?.references?.[0].id, 'cash_a')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('editing contract prose requires payment terms to be checked again before forecasting', () => {
  const db = seed(), service = new NexusService(db)
  assert.ok(projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip').available)
  const c = db.contracts.find((c) => c.id === 'ct_equip')!
  c.clauses[0].body += '<p>新增约定</p>'
  const changed = projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip')
  assert.equal(changed.available, false)
  assert.ok(changed.missing.some((m) => m.includes('一致性')))
  service.updatePaymentTerms(DEFAULT_USER_ID, c.id, c.paymentTerms)
  assert.ok(projectForecast(buildViewState(db, DEFAULT_USER_ID), 'tx_equip').available)
})
