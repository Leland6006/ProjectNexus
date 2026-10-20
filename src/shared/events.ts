// Business event detection.
//
// V0.1 could tell you that clause 6 changed. It could not tell you that the prepayment
// rate dropped from 0.5 to 0.1, which is the fact everything downstream depends on.
// This module turns structured term snapshots into events that carry numbers, so the
// routing rules can branch deterministically instead of asking a model to read prose.

import type { Contract, ContractVersion, DomainEvent, PaymentTerms, Transaction } from './types.ts'

export interface PaymentTermsDelta {
  prepayRateFrom: number
  prepayRateTo: number
  prepayAmountFrom: number
  prepayAmountTo: number
  prepayAmountDelta: number
  settlementDaysFrom: number
  settlementDaysTo: number
  instalmentsFrom: number
  instalmentsTo: number
}

function termsFingerprint(t: PaymentTerms | null): string {
  if (!t) return 'null'
  return JSON.stringify([
    t.prepayRate,
    t.settlementDays,
    t.instalments.map((i) => [i.label, i.rate, i.dueDate])
  ])
}

export function paymentTermsEqual(a: PaymentTerms | null, b: PaymentTerms | null): boolean {
  return termsFingerprint(a) === termsFingerprint(b)
}

/** null when nothing that matters moved. */
export function diffPaymentTerms(
  before: PaymentTerms | null,
  after: PaymentTerms | null,
  amount: number
): PaymentTermsDelta | null {
  if (paymentTermsEqual(before, after)) return null
  const fromRate = before?.prepayRate ?? 0
  const toRate = after?.prepayRate ?? 0
  const fromAmount = Math.round(amount * fromRate * 100) / 100
  const toAmount = Math.round(amount * toRate * 100) / 100
  return {
    prepayRateFrom: fromRate,
    prepayRateTo: toRate,
    prepayAmountFrom: fromAmount,
    prepayAmountTo: toAmount,
    prepayAmountDelta: Math.round((toAmount - fromAmount) * 100) / 100,
    settlementDaysFrom: before?.settlementDays ?? 0,
    settlementDaysTo: after?.settlementDays ?? 0,
    instalmentsFrom: before?.instalments.length ?? 0,
    instalmentsTo: after?.instalments.length ?? 0
  }
}

export interface DetectInput {
  transaction: Transaction
  contract: Contract
  previous: ContractVersion | null
  next: ContractVersion | null
  at: string
  makeId: (prefix: string) => string
}

export function detectPaymentTermsChange(input: DetectInput): DomainEvent | null {
  const { transaction: tx, contract, previous, next, at, makeId } = input
  if (!next) return null
  const delta = diffPaymentTerms(
    previous?.paymentTerms ?? null,
    next.paymentTerms ?? null,
    tx.amount
  )
  if (!delta) return null

  const from = `${Math.round(delta.prepayRateFrom * 100)}%`
  const to = `${Math.round(delta.prepayRateTo * 100)}%`
  const summary =
    delta.prepayRateFrom === delta.prepayRateTo
      ? `付款安排调整：账期 ${delta.settlementDaysFrom} 日 → ${delta.settlementDaysTo} 日`
      : `预付款比例 ${from} → ${to}（¥${delta.prepayAmountFrom.toLocaleString('zh-CN')} → ¥${delta.prepayAmountTo.toLocaleString('zh-CN')}）`

  return {
    id: makeId('ev'),
    type: 'payment_terms_changed',
    transactionId: tx.id,
    contractId: contract.id,
    at,
    summary,
    payload: { ...delta },
    visibility: 'internal'
  }
}

/**
 * Newest two versions of a contract, oldest first. Event detection only needs the last
 * step; replaying the whole history is a Phase 2 concern.
 */
export function latestVersionPair(
  versions: ContractVersion[],
  contractId: string
): [ContractVersion | null, ContractVersion | null] {
  const forContract = versions
    .filter((v) => v.contractId === contractId)
    .sort((a, b) => a.number - b.number)
  if (forContract.length === 0) return [null, null]
  if (forContract.length === 1) return [null, forContract[0]]
  return [forContract[forContract.length - 2], forContract[forContract.length - 1]]
}
