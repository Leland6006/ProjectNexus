import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'
import { approveProposal } from '../src/shared/orchestrator.ts'
import { NexusService } from '../src/shared/service.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSession, handleCall, setLlmClient } from '../src/main/handlers.ts'
import { JsonStore } from '../src/main/store.ts'
import { migrateDatabase } from '../src/shared/migrations.ts'
const at = '2026-10-19T10:00:00Z'

test('approval creates internal tasks exactly once, with unchanged forecast claims', () => {
  const db = createSeedDatabase(), p = db.proposals[0]
  const claims = JSON.stringify(db.claims)
  approveProposal({ db, proposalId: p.id, userId: DEFAULT_USER_ID, at })
  assert.equal(db.tasks.length, p.actions.length)
  assert.ok(db.tasks.every((t) => t.proposalId === p.id && t.steps.length === 3 && t.status === 'open'))
  assert.equal(JSON.stringify(db.claims), claims)
  assert.throws(() => approveProposal({ db, proposalId: p.id, userId: DEFAULT_USER_ID, at }))
  assert.equal(db.tasks.length, p.actions.length)
  assert.deepEqual(buildViewState(db, 'u_b_biz').tasks, [])
  assert.deepEqual(buildViewState(db, 'u_a_counsel').tasks, [])
})

test('tasks enforce sequential steps, revisions, pauses and record only user-reported outcomes', () => {
  const db = createSeedDatabase(), s = new NexusService(db)
  const task = s.createTask(DEFAULT_USER_ID, { transactionId: 'tx_equip', title: '核对交付', detail: '准备并记录结果' })
  assert.throws(() => s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: 0, stepId: task.steps[0].id, result: '核对完成' }))
  s.updateTask(DEFAULT_USER_ID, task.id, { revision: 0, command: 'start', ownerUserId: 'u_a_legal', dueDate: '2026-11-01' })
  assert.throws(() => s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: task.revision, stepId: task.steps[1].id, result: '跳过第一步' }))
  s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: task.revision, stepId: task.steps[0].id, result: '核对合同与验收时间' })
  const revision = task.revision
  s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: 1, stepId: task.steps[0].id, result: '核对合同与验收时间' })
  assert.equal(task.revision, revision)
  s.updateTask(DEFAULT_USER_ID, task.id, { revision, command: 'pause' })
  assert.throws(() => s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: task.revision, stepId: task.steps[1].id, result: '不能绕过暂停' }))
  s.updateTask(DEFAULT_USER_ID, task.id, { revision: task.revision, command: 'resume' })
  for (const step of task.steps.filter((s) => s.status === 'pending')) s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: task.revision, stepId: step.id, result: '用户完成材料核对并记录待办结果' })
  assert.equal(task.status, 'completed')
  const evidence = db.claims.filter((c) => c.source.ref === task.id)
  assert.equal(evidence.length, 1)
  assert.match(evidence[0].source.detail!, /不代表已核验/)
  const final = task.steps.at(-1)!
  s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: 0, stepId: final.id, result: final.result! })
  assert.equal(db.claims.filter((c) => c.source.ref === task.id).length, 1)
})

test('task changes reject other companies, counsel, invalid dates and stale commands before mutation', () => {
  const db = createSeedDatabase(), s = new NexusService(db)
  const t = s.createTask(DEFAULT_USER_ID, { transactionId: 'tx_equip', title: '测试任务', detail: '测试' })
  for (const user of ['u_b_biz', 'u_c_biz', 'u_a_counsel']) assert.throws(() => s.updateTask(user, t.id, { revision: 0, command: 'start' }))
  assert.throws(() => s.updateTask(DEFAULT_USER_ID, t.id, { revision: 0, ownerUserId: 'u_b_biz' }))
  assert.throws(() => s.updateTask(DEFAULT_USER_ID, t.id, { revision: 0, dueDate: '2026-02-30' }))
  assert.equal(t.revision, 0)
})

test('business changes require human review before continuing existing approved tasks', () => {
  const db = createSeedDatabase(), s = new NexusService(db)
  const t = s.createTask(DEFAULT_USER_ID, { transactionId: 'tx_equip', title: '跟进项目', detail: '测试' })
  s.updateTask(DEFAULT_USER_ID, t.id, { revision: 0, command: 'start' })
  s.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '账户', openingBalance: 100, asOf: '2026-10-19' })
  assert.equal(t.requiresReview, true)
  assert.throws(() => s.completeTaskStep(DEFAULT_USER_ID, t.id, { revision: t.revision, stepId: t.steps[0].id, result: '不可直接继续' }))
  s.updateTask(DEFAULT_USER_ID, t.id, { revision: t.revision, command: 'reviewed' })
  s.completeTaskStep(DEFAULT_USER_ID, t.id, { revision: t.revision, stepId: t.steps[0].id, result: '重新核对后继续' })
})

test('analysis checkpoints survive pause and resume without repeating completed finance', async () => {
  const db = createSeedDatabase(), session = createSession(db, DEFAULT_USER_ID, () => {})
  let first = true
  let release!: () => void
  setLlmClient({ complete: async (req) => {
    if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; req.signal?.addEventListener('abort', () => resolve(), { once: true }) }) }
    req.signal?.throwIfAborted()
    return '- 比较收款安排\n- 核对成本并准备沟通'
  } })
  try {
    const pending = handleCall(session, 'runAgents', ['tx_equip'])
    await new Promise((r) => setImmediate(r))
    const run = db.analysisRuns.at(-1)!
    const finance = JSON.stringify(run.steps.find((s) => s.agentId === 'finance'))
    assert.equal((await handleCall(session, 'pauseAnalysis', [run.id])).ok, true)
    release(); await pending
    assert.equal(run.status, 'paused')
    assert.equal((await handleCall(session, 'resumeAnalysis', [run.id])).ok, true)
    assert.equal(run.status, 'completed')
    assert.equal(JSON.stringify(run.steps.find((s) => s.agentId === 'finance')), finance)
    assert.ok(run.steps.some((s) => s.agentId === 'main'))
    assert.equal(db.proposals.find((p) => p.id === run.proposalId)?.analysisRunId, run.id)
    assert.deepEqual(buildViewState(db, 'u_b_biz').analysisRuns, [])
  } finally { setLlmClient(null) }
})

test('source changes prevent resuming a stale analysis; cost changes emit a genuine event', async () => {
  const db = createSeedDatabase(), session = createSession(db, DEFAULT_USER_ID, () => {})
  setLlmClient({ complete: async () => { throw new Error('test failure') } })
  try {
    await handleCall(session, 'runAgents', ['tx_equip'])
    const failed = db.analysisRuns.at(-1)!
    assert.equal(failed.status, 'failed')
    session.service.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '账户', openingBalance: 150001, asOf: '2026-10-18' })
    assert.equal((await handleCall(session, 'resumeAnalysis', [failed.id])).ok, false)
    assert.equal(failed.status, 'stale')
  } finally { setLlmClient(null) }
  await handleCall(session, 'saveCostItem', [{ transactionId: 'tx_equip', name: '新增成本', amount: 1000, dueDate: '2026-11-12', status: 'committed' }])
  assert.equal(db.analysisRuns.at(-1)?.event?.type, 'cost_committed')
})

test('schema migration and process restart preserve tasks and pause interrupted analyses', async () => {
  const db = createSeedDatabase()
  const v4 = structuredClone(db) as unknown as Record<string, unknown>
  v4.schemaVersion = 4; delete v4.analysisRuns; delete v4.tasks
  const migrated = migrateDatabase(v4)
  assert.ok(migrated.ok)
  if (migrated.ok) { assert.deepEqual(migrated.db.tasks, []); assert.equal(migrated.db.transactions.length, db.transactions.length) }
  const dir = mkdtempSync(join(tmpdir(), 'nexus-round3-'))
  try {
    const s = new NexusService(db)
    const task = s.createTask(DEFAULT_USER_ID, { transactionId: 'tx_equip', title: '重启测试', detail: '保留当前进度' })
    s.updateTask(DEFAULT_USER_ID, task.id, { revision: 0, command: 'start' })
    s.completeTaskStep(DEFAULT_USER_ID, task.id, { revision: task.revision, stepId: task.steps[0].id, result: '已核对资料' })
    db.analysisRuns.push({ id: 'interrupted', orgId: task.orgId, transactionId: task.transactionId, createdBy: DEFAULT_USER_ID, status: 'running', trigger: '测试', event: null, sourceRevision: 'test', provider: 'local-finance', steps: [], proposalId: null, error: null, createdAt: at, updatedAt: at })
    const store = new JsonStore(dir); store.save({ db, currentUserId: DEFAULT_USER_ID }); store.flush()
    const restored = new JsonStore(dir).load().db
    assert.equal(restored.analysisRuns[0].status, 'paused')
    assert.equal(restored.tasks[0].steps[0].result, '已核对资料')
    assert.equal(restored.tasks[0].status, 'waiting_user')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
