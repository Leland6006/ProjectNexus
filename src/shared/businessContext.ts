import { companyFinance } from './ledger.ts'
import { clausesFingerprint } from './terms.ts'
// Read-only business tools. The only input is a permission-filtered view, never Database.
import { htmlToText } from './diff.ts'
import { attentionItems } from './briefing.ts'
import { forecastCashflow } from './finance.ts'
import type { DataReference, ViewState, ProfileUpdateDraft } from './types.ts'

export function projectForecast(view: ViewState, transactionId: string) {
  const tx = view.transactions.find((t) => t.id === transactionId)
  if (!tx) throw new Error('项目不存在或无权访问')
  const contract = view.contracts.filter((c) => c.transactionId === tx.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const terms = contract?.paymentTerms
  const costs = view.costItems.filter((c) => c.transactionId === tx.id && c.orgId === view.users.find((u) => u.id === view.currentUserId)?.orgId)
  const accounts = view.cashAccounts
  const missing: string[] = []
  if (view.cashEntries.some((e) => e.status === 'posted') || view.cashPlans.some((p) => p.status === 'active' && p.transactionId === tx.id)) missing.push('已有实际收支或核对计划，请改用资金概览的公司计划预测，避免与合同模拟重复计算')
  if (!terms) missing.push('结构化付款安排')
  if (contract && (!terms?.verifiedClausesFingerprint || terms.verifiedClausesFingerprint !== clausesFingerprint(contract.clauses))) missing.push('付款安排与当前合同正文的一致性确认')
  if (!terms?.payerOrgId) missing.push('付款方')
  if (!terms?.acceptanceDate) missing.push('预计验收日')
  if (!accounts.length) missing.push('现金余额与日期')
  if (!costs.length) missing.push('项目成本（包括无成本的明确确认）')
  if (new Set(accounts.map((a) => a.asOf)).size > 1) missing.push('所有现金账户须使用同一余额日期')
  const balanceDate = accounts[0]?.asOf
  if (balanceDate && tx.expectedSignDate <= balanceDate) missing.push('签约/预付日在余额日之后的付款计划（已有到账尚未核对）')
  if (balanceDate && costs.some((c) => c.status !== 'paid' && c.dueDate <= balanceDate)) missing.push('余额日前未结成本的最新支付日期')
  if (balanceDate && terms?.instalments.some((i) => i.dueDate <= balanceDate)) missing.push('余额日前分期款的到账/支付核对')
  if (missing.length || !terms) return { available: false as const, missing, note: '信息不足，未计算资金缺口。零余额和缺少余额是不同情况。' }
  const orgId = view.users.find((u) => u.id === view.currentUserId)!.orgId
  const account = { ...accounts[0], openingBalance: Math.round(accounts.reduce((sum, a) => sum + a.openingBalance, 0) * 100) / 100 }
  return { available: true as const, missing: [], forecast: forecastCashflow({ transaction: tx, terms, costs, account, perspectiveOrgId: orgId }), assumptions: ['单项目预测，非公司整体现金流', '期初余额已包含已支付成本，因此不再重复扣减', '同一天收付按日净额计算，不代表日内可用资金', '未包含其他项目及未录入收支'] }
}

export const BUSINESS_TOOLS = [
  { type: 'function', function: { name: 'finance_context', description: '读取本企业已核对收付计划、实际收支与跨项目资金预测；区分人工快照、用户报告和预测，不代表银行或税务验证', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'propose_profile_update', description: '仅当用户明确要求修改公司经营信息时准备待确认草稿，不执行写入；用户需要核对页面并点击确认', parameters: { type: 'object', properties: { industry: { type: 'string' }, business: { type: 'string' }, goal: { type: 'string' }, stage: { type: 'string' }, region: { type: 'string' }, teamSize: { type: ['integer', 'null'] } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'contract_details', description: '读取有权限查看的合同条款正文，核对具体条款；不读取评论或内部讨论', parameters: { type: 'object', properties: { contractId: { type: 'string' } }, required: ['contractId'], additionalProperties: false } } },
  { type: 'function', function: { name: 'company_context', description: '读取本企业背景、现金余额、已确认企业记忆；不含其他企业私有资料', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'list_projects', description: '列出有权限的业务项目及其ID', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'project_details', description: '读取指定项目付款、成本、履约及程序计算的现金流；信息不足会返回缺失项', parameters: { type: 'object', properties: { transactionId: { type: 'string' } }, required: ['transactionId'], additionalProperties: false } } },
  { type: 'function', function: { name: 'attention_items', description: '读取基于当前可见数据生成的经营提醒', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
]

export function queryBusiness(view: ViewState, tool: string, args: Record<string, unknown>): { data: unknown; references: DataReference[]; profileUpdate?: ProfileUpdateDraft } {
  const me = view.users.find((u) => u.id === view.currentUserId)!
  const ref = (id: string, label: string, detail: string): DataReference => ({ id, label, detail })
  if (tool === 'propose_profile_update') {
    if (me.role === 'external_counsel') throw new Error('无权修改企业资料')
    const current = view.organizations.find((o) => o.id === me.orgId)?.profile
    const values = { industry: current?.industry ?? '', business: current?.business ?? '', goal: current?.goal ?? '', stage: current?.stage ?? '', region: current?.region ?? '', teamSize: current?.teamSize ?? null }
    const keys = ['industry', 'business', 'goal', 'stage', 'region', 'teamSize'] as const
    if (!Object.keys(args).length || Object.keys(args).some((k) => !keys.includes(k as typeof keys[number]))) throw new Error('无效的修改字段')
    for (const key of keys) {
      if (!(key in args)) continue
      const value = args[key]
      if (key === 'teamSize') {
        if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100000)) throw new Error('无效团队规模')
        values.teamSize = value as number | null
      } else {
        const max = key === 'goal' || key === 'business' ? 2000 : 100
        if (typeof value !== 'string' || value.length > max) throw new Error('字段无效')
        values[key] = value.trim()
      }
    }
    const profileUpdate: ProfileUpdateDraft = { values, baseUpdatedAt: current?.updatedAt ?? null }
    return { data: { status: 'draft_only', message: '已准备公司经营资料草稿；尚未保存，等待用户在回答下方核对确认。', values }, references: [ref(me.orgId, '当前经营资料', current?.updatedAt ?? '尚未录入')], profileUpdate }
  }
  if (tool === 'finance_context') {
    if (me.role === 'external_counsel') throw new Error('无权访问本企业资金账')
    return { data: { finance: companyFinance(view), entries: view.cashEntries.slice(-100), invoiceCases: view.invoiceCases.map(({ buyerTaxId, ...item }) => ({ ...item, buyerTaxId: '身份信息已隐藏' })) }, references: [ref('ledger', '企业资金台账', '人工余额快照 + 实际收支记录 + 未结收付计划；非银行或税务验证')] }
  }
  if (tool === 'company_context') {
    const org = view.organizations.find((o) => o.id === me.orgId)
    return { data: { company: org, accounts: view.cashAccounts, finance: me.role !== 'external_counsel' ? companyFinance(view) : null, confirmedMemory: view.claims.filter((c) => c.orgId === me.orgId && c.status === 'confirmed' && !c.supersededById).slice(0, 60), limitations: '余额为人工快照；未接入专业知识库或外部实时资料。' }, references: [ref(me.orgId, '公司资料与企业记忆', org?.profile?.updatedAt ?? '演示登记资料'), ...view.cashAccounts.map((a) => ref(a.id, a.label, `${a.asOf} 余额 ¥${a.openingBalance}`))] }
  }
  if (tool === 'list_projects') return { data: view.transactions.slice(0, 100), references: view.transactions.slice(0, 100).map((t) => ref(t.id, t.name, `合同约定 ¥${t.amount}；更新 ${t.updatedAt}`)) }
  if (tool === 'attention_items') return { data: attentionItems(view, new Date()), references: [ref('attention', '经营提醒', '根据当前可见方案、建议和履约节点生成')] }
  if (tool === 'contract_details') {
    const contract = view.contracts.find((c) => c.id === args.contractId)
    if (!contract) throw new Error('合同不存在或无权访问')
    return { data: { id: contract.id, title: contract.title, clauses: contract.clauses.slice(0, 40).map((c) => ({ id: c.id, title: c.title, text: htmlToText(c.body).slice(0, 2000) })), note: '最多返回前40条，每条2000字；如有截断请先缩小审阅范围。未接入最新法规知识库。' }, references: [ref(contract.id, contract.title, `合同草稿；更新 ${contract.updatedAt}`)] }
  }
  if (tool === 'project_details') {
    const tx = view.transactions.find((t) => t.id === args.transactionId)
    if (!tx) throw new Error('项目不存在或无权访问')
    const contracts = view.contracts.filter((c) => c.transactionId === tx.id)
    const costs = view.costItems.filter((c) => c.transactionId === tx.id && c.orgId === me.orgId)
    return { data: { transaction: tx, contracts: contracts.map(({ id, title, paymentTerms, updatedAt }) => ({ id, title, paymentTerms, updatedAt })), costs, milestones: view.milestones.filter((m) => m.transactionId === tx.id), cashflow: projectForecast(view, tx.id) }, references: [ref(tx.id, tx.name, `业务更新 ${tx.updatedAt}`), ...contracts.map((c) => ref(c.id, c.title, `结构化付款安排；更新 ${c.updatedAt}`)), ...costs.map((c) => ref(c.id, c.name, `¥${c.amount}；${c.status}；${c.dueDate}`)), ...view.cashAccounts.map((a) => ref(a.id, a.label, `余额日期 ${a.asOf}；¥${a.openingBalance}`))] }
  }
  throw new Error('未授权的工具')
}
