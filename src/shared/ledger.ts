import { canViewTransaction } from './permissions.ts'
import { NexusError, type Database, type ViewState, type CashPlan, type CashEntry, type InvoiceCase } from './types.ts'

export function businessDate(at: string | Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  return ['year', 'month', 'day'].map((t) => parts.find((p) => p.type === t)!.value).join('-')
}
function fail(message: string): never { throw new NexusError('INVALID_INPUT', message) }
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const text = (s: unknown, name: string, max = 200) => typeof s === 'string' && s.trim() && s.length <= max ? s.trim() : fail(`${name}不能为空且不能超过${max}字`)
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > .001) fail('金额须大于零、最多两位小数且不超过一万亿元')
  return Math.round((value as number) * 100) / 100
}
const cents = (n: number) => Math.round(n * 100)
export function checkedDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('日期须为有效的 YYYY-MM-DD')
  return value as string
}
function member(db: Database, id: string) {
  const user = db.users.find((u) => u.id === id)
  if (!user || user.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '仅本企业成员可管理资金和发票资料')
  return user
}
function project(db: Database, userId: string, transactionId: string | null) {
  const user = member(db, userId)
  if (transactionId && !db.transactions.some((t) => t.id === transactionId && canViewTransaction(user, t))) throw new NexusError('NOT_FOUND', '业务不存在或无权访问')
  return user
}
export function settledAmount(planId: string, entries: CashEntry[]): number {
  return entries.filter((e) => e.planId === planId && e.status === 'posted').reduce((n, e) => n + cents(e.amount), 0) / 100
}
export function remainingAmount(plan: CashPlan, entries: CashEntry[]): number {
  return Math.max(0, cents(plan.amount) - cents(settledAmount(plan.id, entries))) / 100
}
export interface PlanInput {
  id?: string; revision?: number; transactionId: string | null; costItemId?: string | null;
  title: string; direction: 'in' | 'out'; amount: number; dueDate: string
}
export function saveCashPlan(db: Database, userId: string, input: PlanInput, at: string): CashPlan {
  const user = project(db, userId, input.transactionId)
  const old = input.id ? db.cashPlans.find((p) => p.id === input.id && p.orgId === user.orgId) : undefined
  if (input.id && !old) throw new NexusError('NOT_FOUND', '收付计划不存在')
  if (old && (old.revision !== input.revision)) throw new NexusError('CONFLICT', '计划已更新或取消，请刷新')
  if (!['in', 'out'].includes(input.direction)) fail('收支方向无效')
  const costItemId = input.costItemId || null
  if (old && db.cashEntries.some((e) => e.planId === old.id && e.status === 'posted') && (input.direction !== old.direction || input.transactionId !== old.transactionId || costItemId !== old.costItemId)) fail('已有核销记录，不能改变方向、业务或成本关联')
  const value = amount(input.amount)
  if (old && cents(value) < cents(settledAmount(old.id, db.cashEntries))) fail('计划金额不能少于已核销金额')
  const dueDate = checkedDate(input.dueDate), title = text(input.title, '计划名称')
  if (costItemId) {
    const cost = db.costItems.find((c) => c.id === costItemId && c.orgId === user.orgId && c.transactionId === input.transactionId)
    if (!cost || cost.status === 'paid') fail('请选择本企业未支付成本；已支付成本不能再生成待付计划')
    if (input.direction !== 'out' || cents(cost.amount) !== cents(value) || dueDate !== cost.dueDate) fail('关联成本的方向、总金额与日期须和成本记录一致')
    if (db.cashPlans.some((p) => p.costItemId === costItemId && p.id !== old?.id && db.cashEntries.some((e) => e.planId === p.id && e.status === 'posted'))) throw new NexusError('CONFLICT', '该成本有历史核销，请重新启用原计划以保留核销，不要重新按成本总额建计划')
    if (db.cashPlans.some((p) => p.costItemId === costItemId && p.orgId === user.orgId && p.status === 'active' && p.id !== old?.id)) throw new NexusError('CONFLICT', '该成本已有收付计划，不能重复计入')
  }
  const plan: CashPlan = { id: old?.id ?? uid('plan'), orgId: user.orgId, transactionId: input.transactionId || null, costItemId, title, direction: input.direction, amount: value, dueDate, status: 'active', revision: (old?.revision ?? -1) + 1, createdBy: old?.createdBy ?? userId, updatedAt: at }
  if (old) Object.assign(old, plan); else db.cashPlans.push(plan)
  return old ?? plan
}
export function cancelCashPlan(db: Database, userId: string, id: string, revision: number, at: string): void {
  const user = member(db, userId), plan = db.cashPlans.find((p) => p.id === id && p.orgId === user.orgId)
  if (!plan) throw new NexusError('NOT_FOUND', '计划不存在')
  if (plan.revision !== revision || plan.status !== 'active') throw new NexusError('CONFLICT', '计划已更新')
  plan.status = 'cancelled'; plan.revision++; plan.updatedAt = at
}
export interface EntryInput { requestId: string; accountId: string; planId: string | null; transactionId: string | null; direction: 'in' | 'out'; amount: number; date: string; note: string; evidence: string }
export function recordCashEntry(db: Database, userId: string, input: EntryInput, at: string): CashEntry {
  const user = project(db, userId, input.transactionId)
  const requestId = text(input.requestId, '操作编号', 100)
  const normalized = { accountId: text(input.accountId, '账户编号'), planId: input.planId || null, transactionId: input.transactionId || null, direction: input.direction, amount: amount(input.amount), date: checkedDate(input.date), note: text(input.note, '收支说明', 500), evidence: text(input.evidence, '核对依据', 500) }
  if (!['in', 'out'].includes(normalized.direction)) fail('收支方向无效')
  if (normalized.date > businessDate(at)) fail('实际收支日期不能在未来，请改用收付计划')
  const old = db.cashEntries.find((e) => e.orgId === user.orgId && e.requestId === requestId)
  if (old) {
    if (Object.entries(normalized).some(([k, v]) => old[k as keyof CashEntry] !== v)) throw new NexusError('CONFLICT', '重复操作编号的内容不同，请重新打开录入窗口')
    return old
  }
  if (db.cashEntries.some((e) => e.orgId === user.orgId && e.status === 'posted' && e.accountId === normalized.accountId && e.date === normalized.date && e.direction === normalized.direction && e.amount === normalized.amount && e.evidence === normalized.evidence)) throw new NexusError('CONFLICT', '发现相同账户、日期、金额与核对依据的记录，请先检查是否重复录入')
  if (!db.cashAccounts.some((a) => a.id === input.accountId && a.orgId === user.orgId)) throw new NexusError('NOT_FOUND', '资金账户不存在')
  if (normalized.planId) {
    const p = db.cashPlans.find((p) => p.id === normalized.planId && p.orgId === user.orgId && p.status === 'active')
    if (!p || p.direction !== normalized.direction || p.transactionId !== normalized.transactionId) fail('计划与收支方向或业务不匹配')
    if (cents(normalized.amount) > cents(remainingAmount(p, db.cashEntries))) throw new NexusError('CONFLICT', '核销金额超过计划未结金额，请刷新后核对')
  }
  const entry: CashEntry = { ...normalized, id: uid('entry'), orgId: user.orgId, requestId, status: 'posted', voidReason: null, voidedBy: null, voidedAt: null, createdBy: userId, createdAt: at }
  db.cashEntries.push(entry)
  return entry
}
export function voidCashEntry(db: Database, userId: string, id: string, reason: string, at: string): void {
  const user = member(db, userId), entry = db.cashEntries.find((e) => e.id === id && e.orgId === user.orgId)
  if (!entry) throw new NexusError('NOT_FOUND', '收支记录不存在')
  if (entry.status === 'void') return
  const voidReason = text(reason, '作废原因', 500)
  entry.status = 'void'; entry.voidReason = voidReason; entry.voidedBy = userId; entry.voidedAt = at
}

export function companyFinance(view: ViewState, today = businessDate()) {
  const user = view.users.find((u) => u.id === view.currentUserId)!
  const accounts = view.cashAccounts.filter((a) => a.orgId === user.orgId && user.role !== 'external_counsel')
  const entries = view.cashEntries.filter((e) => e.orgId === user.orgId && e.status === 'posted' && e.date <= today && user.role !== 'external_counsel')
  const plans = view.cashPlans.filter((p) => p.orgId === user.orgId && p.status === 'active' && user.role !== 'external_counsel')
  const missing = accounts.length ? [] : ['请先录入至少一个现金账户及已核对的日终余额']
  if (accounts.some((a) => a.asOf > today)) missing.push('账户余额日期晚于今天，请核对后再计算')
  const balances = accounts.map((a) => ({ ...a, currentBalance: (cents(a.openingBalance) + entries.filter((e) => e.accountId === a.id && e.date > a.asOf).reduce((n, e) => n + (e.direction === 'in' ? 1 : -1) * cents(e.amount), 0)) / 100 }))
  const opening = balances.reduce((n, a) => n + cents(a.currentBalance), 0)
  const remaining = plans.map((p) => ({ ...p, settled: settledAmount(p.id, entries), remaining: remainingAmount(p, entries) }))
  const points = new Map<string, { inflow: number; outflow: number }>()
  for (const p of remaining) {
    const date = p.dueDate < today ? today : p.dueDate
    const point = points.get(date) ?? { inflow: 0, outflow: 0 }
    if (p.direction === 'in') point.inflow += cents(p.remaining); else point.outflow += cents(p.remaining)
    points.set(date, point)
  }
  let balance = opening, conservative = opening, lowest = opening, lowestWithoutReceipts = opening
  const timeline = [...points.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, p]) => {
    balance += p.inflow - p.outflow; conservative -= p.outflow
    lowest = Math.min(lowest, balance); lowestWithoutReceipts = Math.min(lowestWithoutReceipts, conservative)
    return { date, inflow: p.inflow / 100, outflow: p.outflow / 100, balance: balance / 100, withoutReceipts: conservative / 100 }
  })
  const uncoveredCosts = view.costItems.filter((c) => c.orgId === user.orgId && c.status !== 'paid' && !plans.some((p) => p.costItemId === c.id)).length
  return { available: !missing.length, missing, today, balances, currentBalance: missing.length ? null : opening / 100, remaining, timeline: missing.length ? [] : timeline,
    shortfall: missing.length ? null : Math.max(0, -lowest) / 100, withoutReceiptsShortfall: missing.length ? null : Math.max(0, -lowestWithoutReceipts) / 100,
    receivables: remaining.filter((p) => p.direction === 'in').reduce((n, p) => n + cents(p.remaining), 0) / 100,
    payables: remaining.filter((p) => p.direction === 'out').reduce((n, p) => n + cents(p.remaining), 0) / 100,
    uncoveredCosts,
    notes: ['仅按人工核对的收付计划跨项目汇总，未录入的款项不包含在内；不是完整会计账簿或银行余额。', '余额快照视为当日日终，快照当日及以前记录已包含在快照中，不再加减。更新快照后仅加减新日期之后的记录。', '计划只计未核销部分；合同总额、履约节点、成本不会再次自动叠加。需用成本关联计划避免重复手录。', '逾期未结款项假设今日发生；预计收款可能延迟，同时展示不含未来收款的支出压力。', '历史收支作废不改写人工余额快照，涉及快照当日及以前的错误请重新核对余额。'] }
}

export function saveInvoiceCase(db: Database, userId: string, input: { id?: string; revision?: number; transactionId: string; title: string; buyerName: string; buyerTaxId: string; itemName: string; amount: number; note?: string }, at: string): InvoiceCase {
  const transactionId = text(input.transactionId, '所属业务')
  const user = project(db, userId, transactionId)
  const old = input.id ? db.invoiceCases.find((i) => i.id === input.id && i.orgId === user.orgId) : undefined
  if (input.id && !old) throw new NexusError('NOT_FOUND', '发票事项不存在')
  if (old && (old.revision !== input.revision || old.stage !== 'materials')) throw new NexusError('CONFLICT', '事项已更新或已进入核对阶段')
  const item: InvoiceCase = { id: old?.id ?? uid('invoice'), orgId: user.orgId, transactionId: input.transactionId, title: text(input.title, '事项名称'), buyerName: text(input.buyerName, '购买方名称'), buyerTaxId: text(input.buyerTaxId, '购买方识别信息', 100), itemName: text(input.itemName, '商品或服务名称'), amount: amount(input.amount), note: String(input.note ?? '').slice(0, 2000), stage: 'materials', invoiceNumber: null, result: null, revision: (old?.revision ?? -1) + 1, history: old?.history ?? [], createdAt: old?.createdAt ?? at }
  item.history = [...item.history, { at, actorId: userId, summary: '保存待核对开票材料；不代表税务审核或已开票' }]
  if (old) Object.assign(old, item); else db.invoiceCases.push(item)
  return old ?? item
}
export function advanceInvoiceCase(db: Database, userId: string, id: string, input: { revision: number; command: 'check' | 'submit' | 'record' | 'reopen'; result: string; invoiceNumber?: string }, at: string): InvoiceCase {
  const user = member(db, userId), item = db.invoiceCases.find((i) => i.id === id && i.orgId === user.orgId)
  if (!item) throw new NexusError('NOT_FOUND', '发票事项不存在')
  if (item.revision !== input.revision) throw new NexusError('CONFLICT', '事项已更新，请刷新')
  const next = { materials: 'check', checked: 'submit', submitted: 'record' }
  if (input.command !== 'reopen' && next[item.stage as keyof typeof next] !== input.command) fail('请按资料、核对、用户办理、结果记录的顺序推进')
  const result = text(input.result, '本步核对或办理记录', 2000)
  const number = input.command === 'record' ? text(input.invoiceNumber, '发票号码', 100) : null
  item.stage = input.command === 'reopen' ? 'materials' : input.command === 'check' ? 'checked' : input.command === 'submit' ? 'submitted' : 'recorded'
  item.result = result; item.invoiceNumber = number; item.revision++
  item.history.push({ at, actorId: userId, summary: `${({ check: '用户核对材料', submit: '用户报告已自行提交办理', record: '用户记录发票结果（未连接税务系统验证）', reopen: '重新整理材料，原记录保留在历史' })[input.command]}：${result}${number ? `；号码：${number}` : ''}` })
  return item
}
