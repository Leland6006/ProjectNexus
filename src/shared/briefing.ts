import { businessDate, remainingAmount } from './ledger.ts'
import { reviewFingerprint } from './terms.ts'
import { isStaleProposal } from './proposalView.ts'
// "What needs attention" for the acting account, derived only from data it can see.
//
// Every item names where it came from. When there is nothing, the list is empty: the
// home page must never invent an operating status to look busy.

import { effectiveOrgId, isPartyMember } from './permissions.ts'
import type { ViewState } from './types.ts'

export type AttentionKind = 'decision' | 'suggestion' | 'milestone' | 'task' | 'review' | 'finance' | 'invoice'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  title: string
  detail: string
  /** Human-readable origin of the item, e.g. "履约节点 · 计划日期 2026-10-22". */
  source: string
  transactionId: string
  contractId: string | null
  /** Lower is more urgent. */
  urgency: number
  /** Sort key within the same urgency (ISO date or timestamp). */
  at: string
}

const DAY = 86_400_000

function daysFrom(dateStr: string, now: Date): number {
  const target = Date.parse(`${dateStr}T00:00:00`)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((target - today) / DAY)
}

export function attentionItems(s: ViewState, now: Date, horizonDays = 14): AttentionItem[] {
  const user = s.users.find((u) => u.id === s.currentUserId)
  if (!user) return []
  const txName = (id: string): string => s.transactions.find((t) => t.id === id)?.name ?? '业务项目'
  const items: AttentionItem[] = []

  // Proposals are already limited to members of the owning company by buildViewState.
  for (const p of s.proposals) {
    if (p.status !== 'pending') continue
    items.push({
      id: `decision:${p.id}`,
      kind: 'decision',
      title: isStaleProposal(s.versions, p) ? `需重新分析：${txName(p.transactionId)}` : p.title,
      detail: txName(p.transactionId),
      source: `AI 建议 · 生成于 ${p.createdAt.slice(0, 10)}`,
      transactionId: p.transactionId,
      contractId: p.contractId,
      urgency: 1,
      at: p.createdAt
    })
  }

  for (const task of s.tasks) {
    if (['completed', 'cancelled'].includes(task.status)) continue
    const overdue = task.dueDate && daysFrom(task.dueDate, now) < 0
    if (task.requiresReview || task.status === 'waiting_user' || overdue) items.push({
      id: `task:${task.id}`, kind: 'task', title: task.requiresReview ? `需核对最新资料：${task.title}` : task.title,
      detail: txName(task.transactionId), source: `任务 · 更新 ${task.updatedAt.slice(0, 10)}`,
      transactionId: task.transactionId, contractId: task.contractId, urgency: overdue ? 0 : 2, at: task.updatedAt
    })
  }

  // Contract changes the other side proposed and this side has not answered.
  for (const sg of s.suggestions) {
    if (sg.status !== 'pending') continue
    const contract = s.contracts.find((c) => c.id === sg.contractId)
    const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)
    if (!contract || !tx || !isPartyMember(user, tx)) continue
    if (effectiveOrgId(user, tx, s.representingOrgId) === sg.orgId) continue
    const clause = contract.clauses.find((c) => c.id === sg.clauseId)
    items.push({
      id: `suggestion:${sg.id}`,
      kind: 'suggestion',
      title: `对方建议修改「${clause?.title ?? '条款'}」，等待我方处理`,
      detail: `${tx.name} · ${contract.title}`,
      source: `合同修改建议 · 提出于 ${sg.createdAt.slice(0, 10)}`,
      transactionId: tx.id,
      contractId: contract.id,
      urgency: 2,
      at: sg.createdAt
    })
  }

  for (const m of s.milestones) {
    if (m.status === 'completed') continue
    const d = daysFrom(m.dueDate, now)
    if (Number.isNaN(d) || d > horizonDays) continue
    items.push({
      id: `milestone:${m.id}`,
      kind: 'milestone',
      title: d < 0 ? `「${m.name}」已逾期 ${-d} 天` : d === 0 ? `「${m.name}」今天到期` : `「${m.name}」${d} 天后到期`,
      detail: txName(m.transactionId),
      source: `履约节点 · 计划日期 ${m.dueDate}`,
      transactionId: m.transactionId,
      contractId: null,
      urgency: d < 0 ? 0 : 3,
      at: m.dueDate
    })
  }

  for (const r of s.internalReviews) if (r.status === 'pending' && r.reviewerId === user.id) {
    const contract = s.contracts.find((c) => c.id === r.contractId)
    if (!contract || reviewFingerprint(contract, s.versions) !== r.sourceFingerprint) continue
    items.push({ id: `review:${r.id}`, kind: 'review', title: '一份合同等待你的内部审阅', detail: txName(r.transactionId), source: `内部审阅 · 发起于 ${r.createdAt.slice(0, 10)}`, transactionId: r.transactionId, contractId: r.contractId, urgency: 2, at: r.createdAt })
  }
  for (const p of s.cashPlans) if (p.status === 'active' && remainingAmount(p, s.cashEntries) > 0 && p.dueDate <= businessDate(new Date(now.getTime() + horizonDays * DAY))) {
    items.push({ id: `cashplan:${p.id}`, kind: 'finance', title: `${p.direction === 'in' ? '待收' : '待付'}「${p.title}」¥${remainingAmount(p, s.cashEntries).toLocaleString('zh-CN')}`, detail: p.transactionId ? txName(p.transactionId) : '公司日常事务', source: `人工核对计划 · ${p.dueDate}`, transactionId: p.transactionId ?? '', contractId: null, urgency: p.dueDate < businessDate(now) ? 1 : 3, at: p.dueDate })
  }
  for (const i of s.invoiceCases) if (i.stage !== 'recorded') items.push({ id: `invoice:${i.id}`, kind: 'invoice', title: `发票事项「${i.title}」待继续`, detail: txName(i.transactionId), source: '用户材料与办理记录 · 尚未连接税务验证', transactionId: i.transactionId, contractId: null, urgency: 4, at: i.createdAt })
  return items.sort((a, b) => a.urgency - b.urgency || a.at.localeCompare(b.at))
}

/** The short list on the home page. */
export function todayBriefing(s: ViewState, now: Date, limit = 3): AttentionItem[] {
  return attentionItems(s, now).slice(0, limit)
}
