// "What needs attention" for the acting account, derived only from data it can see.
//
// Every item names where it came from. When there is nothing, the list is empty: the
// home page must never invent an operating status to look busy.

import { effectiveOrgId, isPartyMember } from './permissions.ts'
import type { ViewState } from './types.ts'

export type AttentionKind = 'decision' | 'suggestion' | 'milestone'

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
      title: p.title,
      detail: txName(p.transactionId),
      source: `AI 建议 · 生成于 ${p.createdAt.slice(0, 10)}`,
      transactionId: p.transactionId,
      contractId: p.contractId,
      urgency: 1,
      at: p.createdAt
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

  return items.sort((a, b) => a.urgency - b.urgency || a.at.localeCompare(b.at))
}

/** The short list on the home page. */
export function todayBriefing(s: ViewState, now: Date, limit = 3): AttentionItem[] {
  return attentionItems(s, now).slice(0, limit)
}
