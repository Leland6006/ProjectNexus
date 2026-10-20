// Cash-flow projection. Deliberately model-free.
//
// Money questions need exact arithmetic, not plausible prose. A model asked "is there a
// funding gap?" will produce a confident sentence; this module produces the number, the
// date it happens, and the timeline that explains it. The agent's job is to interpret
// the result, never to compute it.

import type { CashAccount, CostItem, PaymentTerms, Transaction } from './types.ts'

export interface CashflowLine {
  label: string
  amount: number
  date: string
}

export interface TimelinePoint {
  date: string
  delta: number
  balance: number
}

export interface CashflowForecast {
  openingBalance: number
  inflows: CashflowLine[]
  outflows: CashflowLine[]
  timeline: TimelinePoint[]
  /** Lowest balance on the horizon. Negative when the plan runs out of cash. */
  minBalance: number
  /** Positive amount of extra cash needed at the worst point; 0 when never short. */
  shortfall: number
  shortfallDate: string | null
}

function day(value: string): string {
  return value.slice(0, 10)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${day(date)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function money(value: number): number {
  return Math.round(value * 100) / 100
}

/** Instalments derived from the structured payment terms. */
export function paymentSchedule(tx: Transaction, terms: PaymentTerms): CashflowLine[] {
  const start = day(tx.expectedSignDate)
  const lines: CashflowLine[] = []

  if (terms.prepayRate > 0) {
    lines.push({ label: '预付款', amount: money(tx.amount * terms.prepayRate), date: start })
  }

  let allocated = terms.prepayRate
  let latest = start
  for (const inst of terms.instalments) {
    const when = day(inst.dueDate)
    lines.push({ label: inst.label, amount: money(tx.amount * inst.rate), date: when })
    allocated += inst.rate
    if (when > latest) latest = when
  }

  const remainder = Math.max(0, 1 - allocated)
  if (remainder > 0) {
    lines.push({
      label: `验收后 ${terms.settlementDays} 日尾款`,
      amount: money(tx.amount * remainder),
      date: addDays(latest, terms.settlementDays)
    })
  }
  return lines
}

export interface ForecastInput {
  transaction: Transaction
  terms: PaymentTerms
  /** Already scoped to the viewer; the caller decides whose costs count. */
  costs?: CostItem[]
  account?: CashAccount | null
}

/**
 * Walks the horizon day by day. Costs are cash out, instalments are cash in, and the
 * answer is the worst point in between — not the net total, which is the mistake every
 * naive "can we afford this?" calculation makes.
 */
export function forecastCashflow(input: ForecastInput): CashflowForecast {
  const { transaction: tx, terms, costs = [], account = null } = input
  const inflows = paymentSchedule(tx, terms)
  const outflows: CashflowLine[] = costs.map((c) => ({
    label: c.name,
    amount: money(c.amount),
    date: day(c.dueDate)
  }))

  const points: { date: string; delta: number }[] = [
    ...inflows.map((l) => ({ date: l.date, delta: l.amount })),
    ...outflows.map((l) => ({ date: l.date, delta: -l.amount }))
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  let balance = account?.openingBalance ?? 0
  const timeline: TimelinePoint[] = []
  let minBalance = balance
  let shortfallDate: string | null =
    balance < 0 ? (account?.asOf ?? day(tx.expectedSignDate)) : null

  for (const p of points) {
    balance = money(balance + p.delta)
    timeline.push({ date: p.date, delta: p.delta, balance })
    if (balance < minBalance) {
      minBalance = balance
      shortfallDate = p.date
    }
  }

  return {
    openingBalance: account?.openingBalance ?? 0,
    inflows,
    outflows,
    timeline,
    minBalance,
    shortfall: Math.max(0, money(-minBalance)),
    shortfallDate: minBalance < 0 ? shortfallDate : null
  }
}

/** One-line rendering used by agent prompts and by the UI. */
export function describeForecast(f: CashflowForecast): string {
  if (f.shortfall > 0) {
    return `预计在 ${f.shortfallDate ?? '未知日期'} 出现资金缺口 ¥${f.shortfall.toLocaleString('zh-CN')}（最低余额 ¥${f.minBalance.toLocaleString('zh-CN')}）。`
  }
  return `按当前安排不会出现资金缺口（最低余额 ¥${f.minBalance.toLocaleString('zh-CN')}）。`
}
