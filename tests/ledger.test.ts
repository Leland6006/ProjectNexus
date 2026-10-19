import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'
import { NexusService } from '../src/shared/service.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { businessDate, companyFinance, remainingAmount } from '../src/shared/ledger.ts'
import { projectForecast, queryBusiness } from '../src/shared/businessContext.ts'
import { attentionItems } from '../src/shared/briefing.ts'
import { migrateDatabase, CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'
import { JsonStore } from '../src/main/store.ts'
import { createSession, handleCall } from '../src/main/handlers.ts'
const at = '2026-10-19T12:00:00Z'
function setup() {
  const db = createSeedDatabase(), service = new NexusService(db, () => {}, { now: () => at })
  const account = service.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '测试账户', openingBalance: 1000, asOf: '2026-10-15' })
  const view = () => buildViewState(db, DEFAULT_USER_ID)
  const finance = () => companyFinance(view(), '2026-10-19')
  const plan = (amount = 1000, direction: 'in' | 'out' = 'out', transactionId: string | null = 'tx_equip') => service.saveCashPlan(DEFAULT_USER_ID, { title: '核对计划', transactionId, direction, amount, dueDate: '2026-10-25' })
  const entry = (planId: string | null, amount = 300, direction: 'in' | 'out' = 'out', date = '2026-10-19') => service.recordCashEntry(DEFAULT_USER_ID, { requestId: crypto.randomUUID(), accountId: account.id, planId, transactionId: planId ? db.cashPlans.find((p) => p.id === planId)!.transactionId : null, direction, amount, date, note: '用户核对', evidence: crypto.randomUUID() })
  return { db, service, account, view, finance, plan, entry }
}

test('partial settlement and snapshot rebasing count actual and remaining money exactly once', () => {
  const { db, service, account, plan, entry, finance } = setup(), p = plan()
  entry(p.id)
  assert.equal(finance().currentBalance, 700)
  assert.equal(finance().payables, 700)
  assert.equal(finance().timeline[0].balance, 0)
  assert.equal(remainingAmount(p, db.cashEntries), 700)
  service.saveCashAccount(DEFAULT_USER_ID, { id: account.id, label: account.label, openingBalance: 700, asOf: '2026-10-19' })
  assert.equal(finance().currentBalance, 700)
  assert.equal(finance().timeline[0].balance, 0)
})

test('historical records can settle a plan without being added again to its snapshot', () => {
  const { finance, plan, entry } = setup(), p = plan(500, 'in')
  entry(p.id, 200, 'in', '2026-10-15')
  assert.equal(finance().currentBalance, 1000)
  assert.equal(finance().receivables, 300)
  assert.equal(finance().timeline[0].balance, 1300)
})

test('company forecast reuses opening cash once across projects and distinguishes uncertain receipts', () => {
  const { finance, plan } = setup()
  plan(800, 'out', 'tx_equip'); plan(700, 'out', 'tx_service'); plan(900, 'in', null)
  const f = finance()
  assert.equal(f.currentBalance, 1000)
  assert.equal(f.timeline[0].balance, 400)
  assert.equal(f.shortfall, 0)
  assert.equal(f.withoutReceiptsShortfall, 500)
  assert.equal(f.uncoveredCosts > 0, true)
})

test('accounts with different snapshot dates reconstruct separately before summing', () => {
  const { db, service, account, finance, entry } = setup()
  const second = service.saveCashAccount(DEFAULT_USER_ID, { label: '另一账户', openingBalance: 500, asOf: '2026-10-18' })
  entry(null, 200, 'in', '2026-10-16')
  service.recordCashEntry(DEFAULT_USER_ID, { requestId: 'another', accountId: second.id, planId: null, transactionId: null, direction: 'out', amount: 50, date: '2026-10-19', note: '日常支出', evidence: '另一账户流水' })
  assert.equal(finance().currentBalance, 1650)
  assert.equal(db.cashAccounts.find((a) => a.id === account.id)!.openingBalance, 1000)
})

test('void preserves history, restores settlement and does not rewrite opening balances', () => {
  const { db, service, plan, entry, finance } = setup(), p = plan(), e = entry(p.id)
  service.voidCashEntry(DEFAULT_USER_ID, e.id, '金额录错，核对后重新录入')
  assert.equal(e.status, 'void'); assert.equal(e.voidedBy, DEFAULT_USER_ID)
  assert.equal(finance().currentBalance, 1000); assert.equal(finance().payables, 1000)
  service.voidCashEntry(DEFAULT_USER_ID, e.id, '重复提交')
  assert.equal(db.cashEntries.length, 1)
  assert.equal(e.voidReason, '金额录错，核对后重新录入')
})

test('cash posting is idempotent, rejects changed retries, duplicate evidence and over-allocation atomically', () => {
  const { db, service, account, plan, entry } = setup(), p = plan(100)
  const e = entry(p.id, 80)
  const { requestId, accountId, planId, transactionId, direction, amount, date, note, evidence } = e
  const input = { requestId, accountId, planId, transactionId, direction, amount, date, note, evidence }
  assert.equal(service.recordCashEntry(DEFAULT_USER_ID, input).id, e.id)
  const before = JSON.stringify(db)
  assert.throws(() => service.recordCashEntry(DEFAULT_USER_ID, { ...input, amount: 70 }))
  assert.throws(() => service.recordCashEntry(DEFAULT_USER_ID, { ...input, requestId: 'different' }))
  assert.throws(() => service.recordCashEntry(DEFAULT_USER_ID, { ...input, requestId: 'over', evidence: 'different', amount: 30 }))
  assert.throws(() => service.recordCashEntry(DEFAULT_USER_ID, { ...input, requestId: 'future', planId: null, date: '2026-10-20' }))
  assert.throws(() => service.recordCashEntry(DEFAULT_USER_ID, { ...input, requestId: 'wrongaccount', accountId: 'cash_b' }))
  assert.equal(JSON.stringify(db), before)
  assert.equal(account.openingBalance, 1000)
})

test('plan edits use revisions, cannot undercut settlements or change settled associations, cancelled plans can resume', () => {
  const { db, service, plan, entry, finance } = setup(), p = plan(500)
  entry(p.id, 200)
  const input = { ...p, amount: 100 }
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, input))
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, { ...p, revision: 10 }))
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, { ...p, direction: 'in' }))
  service.cancelCashPlan(DEFAULT_USER_ID, p.id, p.revision)
  assert.equal(finance().payables, 0)
  assert.equal(db.cashEntries.length, 1)
  service.saveCashPlan(DEFAULT_USER_ID, { ...p, amount: 500 })
  assert.equal(finance().payables, 300)
})

test('cost-backed plans prevent double inclusion and block unsynchronised cost edits', () => {
  const { db, service } = setup(), cost = db.costItems.find((c) => c.orgId === db.users.find((u) => u.id === DEFAULT_USER_ID)!.orgId && c.status !== 'paid')!
  const input = { title: cost.name, transactionId: cost.transactionId, costItemId: cost.id, direction: 'out' as const, amount: cost.amount, dueDate: cost.dueDate }
  service.saveCashPlan(DEFAULT_USER_ID, input)
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, input))
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, { ...input, amount: cost.amount + 1 }))
  assert.throws(() => service.saveCostItem(DEFAULT_USER_ID, { ...cost, amount: cost.amount + 1 }))
  assert.equal(db.cashPlans.length, 1)
})

test('other enterprises and external counsel cannot read or mutate the private ledger and invoice cases', () => {
  const { db, service, plan, entry } = setup(), p = plan(), e = entry(p.id)
  for (const id of ['u_b_biz', 'u_a_counsel']) {
    assert.throws(() => service.cancelCashPlan(id, p.id, p.revision))
    assert.throws(() => service.voidCashEntry(id, e.id, '越权'))
    const view = buildViewState(db, id, { demoDirectory: true })
    assert.deepEqual(view.cashPlans, []); assert.deepEqual(view.cashEntries, []); assert.deepEqual(view.invoiceCases, [])
  }
  assert.throws(() => service.saveCashPlan('u_a_counsel', { ...p }))
})

test('date, cents, future snapshots and absent accounts are handled explicitly', () => {
  assert.equal(businessDate('2026-10-18T16:01:00Z'), '2026-10-19')
  const { db, service, plan, finance } = setup()
  assert.throws(() => plan(-1)); assert.throws(() => plan(.001))
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, { ...plan(1), dueDate: '2026-02-30' }))
  const view = buildViewState(db, DEFAULT_USER_ID)
  view.cashAccounts = []
  assert.equal(companyFinance(view).available, false)
  service.saveCashAccount(DEFAULT_USER_ID, { id: 'cash_a', label: '未来快照', openingBalance: 50, asOf: '2026-10-20' })
  assert.equal(finance().available, false); assert.equal(finance().currentBalance, null)
  assert.deepEqual(finance().timeline, [])
})

test('invoice material workflow enforces sequential, human-reported progress and permits correction', () => {
  const { db, service, view } = setup()
  const item = service.saveInvoiceCase(DEFAULT_USER_ID, { transactionId: 'tx_equip', title: '采购开票', buyerName: '测试购买方', buyerTaxId: '测试识别信息', itemName: '技术服务', amount: 200 })
  assert.throws(() => service.advanceInvoiceCase(DEFAULT_USER_ID, item.id, { revision: 0, command: 'record', result: '跳过核对', invoiceNumber: '123' }))
  assert.throws(() => service.advanceInvoiceCase('u_b_biz', item.id, { revision: 0, command: 'check', result: '越权' }))
  for (const command of ['check', 'submit', 'record'] as const) service.advanceInvoiceCase(DEFAULT_USER_ID, item.id, { revision: item.revision, command, result: '用户逐项核对并自行操作', invoiceNumber: 'TEST-001' })
  assert.equal(item.stage, 'recorded'); assert.equal(item.invoiceNumber, 'TEST-001')
  assert.ok(item.history.at(-1)!.summary.includes('未连接税务系统验证'))
  assert.equal(db.cashEntries.length, 0)
  assert.ok(!attentionItems(view(), new Date(at)).some((i) => i.kind === 'invoice'))
  service.advanceInvoiceCase(DEFAULT_USER_ID, item.id, { revision: item.revision, command: 'reopen', result: '重新核对抬头' })
  assert.equal(item.stage, 'materials'); assert.equal(item.invoiceNumber, null)
  assert.equal(item.history.length, 5)
})

test('AI and reminders see ledger sources; legacy simulation stops when reconciliation is present', () => {
  const { view, plan, entry } = setup(), p = plan()
  entry(p.id)
  const data = queryBusiness(view(), 'finance_context', {})
  assert.ok(data.references.length)
  assert.equal((data.data as { finance: { payables: number } }).finance.payables, 700)
  const forecast = projectForecast(view(), 'tx_equip')
  assert.equal(forecast.available, false)
  assert.match(forecast.missing.join(' '), /重复计算/)
  assert.ok(attentionItems(view(), new Date(at)).some((i) => i.kind === 'finance'))
})

test('v6 migration and persistence preserve financial records and invoice history', () => {
  const { db, plan, entry } = setup(), p = plan(); entry(p.id)
  const path = mkdtempSync(join(tmpdir(), 'nexus-ledger-'))
  try {
    const store = new JsonStore(path); store.save({ db, currentUserId: DEFAULT_USER_ID }); store.flush()
    const loaded = new JsonStore(path).load().db
    assert.equal(loaded.cashEntries.length, 1); assert.equal(loaded.cashPlans.length, 1)
    assert.equal(companyFinance(buildViewState(loaded, DEFAULT_USER_ID), '2026-10-19').payables, 700)
    const old = createSeedDatabase() as unknown as Record<string, unknown>
    old.schemaVersion = 6; delete old.cashPlans; delete old.cashEntries; delete old.invoiceCases
    assert.ok(migrateDatabase(old).ok); assert.equal(old.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.deepEqual(old.cashEntries, [])
  } finally { rmSync(path, { recursive: true, force: true }) }
})

test('ledger operations are exposed only through the fixed main-process API allowlist', async () => {
  const { db } = setup(), session = createSession(db, DEFAULT_USER_ID, () => {})
  assert.equal((await handleCall(session, 'saveCashPlan', [{ title: '测试', transactionId: null, direction: 'out', amount: 10, dueDate: '2026-10-30' }])).ok, true)
  assert.equal((await handleCall(session, 'executeBankPayment', [])).ok, false)
})

test('cost plans with historical settlements must resume their original plan instead of counting its total twice', () => {
  const { db, service, entry, finance } = setup()
  const cost = db.costItems.find((c) => c.orgId === db.users.find((u) => u.id === DEFAULT_USER_ID)!.orgId && c.status !== 'paid')!
  const input = { title: cost.name, transactionId: cost.transactionId, costItemId: cost.id, direction: 'out' as const, amount: cost.amount, dueDate: cost.dueDate }
  const p = service.saveCashPlan(DEFAULT_USER_ID, input)
  entry(p.id, 100)
  service.cancelCashPlan(DEFAULT_USER_ID, p.id, p.revision)
  assert.throws(() => service.saveCashPlan(DEFAULT_USER_ID, input), /历史核销/)
  service.saveCashPlan(DEFAULT_USER_ID, { ...input, id: p.id, revision: p.revision })
  assert.equal(finance().payables, cost.amount - 100)
})

test('finance specialist switches to the company ledger and passes scope-qualified predictions to operations', async () => {
  const { db, plan, entry } = setup(), p = plan(2000)
  entry(p.id, 300)
  const { runOrchestrator } = await import('../src/shared/orchestrator.ts')
  const prompts: string[] = []
  const result = await runOrchestrator({ db, userId: DEFAULT_USER_ID, transactionId: 'tx_equip', now: at,
    event: { id: 'ledger-test-event', type: 'business_review_requested', transactionId: 'tx_equip', contractId: null, at, summary: '核对公司资金', payload: {}, visibility: 'internal' },
    llm: { complete: async (r) => { prompts.push(r.user); return '- 请核对已录入计划的覆盖范围。' } } })
  const gap = result.claims.find((c) => c.key === 'cash.company_plan_gap')!
  assert.equal(gap.numeric, 1000)
  assert.equal(gap.status, 'inferred')
  assert.match(gap.value, /不代表本项目单独造成/)
  assert.ok(prompts.some((p) => p.includes('公司已核对计划的条件预测')))
  assert.equal(result.claims.some((c) => c.key === 'cash.gap'), false)
})
