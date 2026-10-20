// Presentation rules for the AI proposal centre.
//
// These live in src/shared, next to the rules they describe, because what a human is
// shown here is a correctness question rather than a styling one: an inference must
// never be rendered the same way as a fact, and a stale draft must never look
// actionable. Keeping it pure means both are testable without a renderer.

import type { AgentId } from './context.ts'
import type {
  Claim,
  ClaimSource,
  ClaimStatus,
  ContractVersion,
  Proposal,
  ProposalStatus,
  ProposedAction
} from './types.ts'

/** Tone names match the Badge component's variants. */
export type Tone = 'gray' | 'blue' | 'indigo' | 'green' | 'amber' | 'red' | 'purple'

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: '待确认',
  approved: '已采纳',
  rejected: '已忽略'
}

export const PROPOSAL_STATUS_TONE: Record<ProposalStatus, Tone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'gray'
}

export const ACTION_KIND_LABEL: Record<ProposedAction['kind'], string> = {
  counter_offer: '还价',
  revise_clause: '修改条款',
  add_task: '待办任务',
  contact_counterparty: '联系对方'
}

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  confirmed: '已确认事实',
  inferred: '推断 / 预测',
  recommended: '建议'
}

export const CLAIM_STATUS_TONE: Record<ClaimStatus, Tone> = {
  confirmed: 'green',
  inferred: 'amber',
  recommended: 'blue'
}

export const SOURCE_KIND_LABEL: Record<ClaimSource['kind'], string> = {
  contract: '合同',
  transaction: '交易',
  ledger: '账目',
  user: '人工录入',
  agent: 'Agent 生成'
}

export const AGENT_LABEL: Record<AgentId, string> = {
  legal: '法务 Agent',
  finance: '财务 Agent',
  ops: '经营 Agent',
  main: 'Nexus 主顾问'
}

/**
 * A draft written by `agent:main` (or a named specialist) reads better than a raw id.
 * Anything else falls back to the source kind.
 */
export function claimAuthorLabel(c: Claim): string {
  if (c.source.kind === 'agent') {
    const ref = c.source.ref as AgentId | undefined
    return (ref && AGENT_LABEL[ref]) || c.source.ref || 'Agent 生成'
  }
  return SOURCE_KIND_LABEL[c.source.kind]
}

export function claimValue(c: Claim): string {
  return c.unit ? `${c.value} ${c.unit}` : c.value
}

export function pendingCount(proposals: Proposal[]): number {
  return proposals.filter((p) => p.status === 'pending').length
}

/**
 * A draft is stale once the contract moved on. Approving it would apply reasoning built
 * on a version nobody is looking at any more, so the UI refuses instead of warning.
 */
export function isStaleProposal(versions: ContractVersion[], proposal: Proposal): boolean {
  if (!proposal.contractId || !proposal.baseVersionId) return false
  let newest: ContractVersion | null = null
  for (const v of versions) {
    if (v.contractId !== proposal.contractId) continue
    if (!newest || v.number > newest.number) newest = v
  }
  return newest !== null && newest.id !== proposal.baseVersionId
}

/** Pending first (newest first), then everything already decided. */
export function sortForReview(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort((a, b) => {
    const rank = (p: Proposal): number => (p.status === 'pending' ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return b.createdAt.localeCompare(a.createdAt)
  })
}

/**
 * The evidence behind a draft, in the order the draft cites it. Ids the viewer cannot
 * see are reported as missing rather than silently dropped: a proposal whose reasoning
 * is partly invisible must not look fully sourced.
 */
export function claimsForProposal(
  claims: Claim[],
  proposal: Proposal
): { found: Claim[]; missing: string[] } {
  const byId = new Map(claims.map((c) => [c.id, c]))
  const found: Claim[] = []
  const missing: string[] = []
  for (const id of proposal.claimIds) {
    const c = byId.get(id)
    if (c) found.push(c)
    else missing.push(id)
  }
  return { found, missing }
}

/** Facts first, then inferences, then recommendations — the order a human should read. */
export function sortClaimsByStatus(claims: Claim[]): Claim[] {
  const rank = (c: Claim): number =>
    c.status === 'confirmed' ? 0 : c.status === 'inferred' ? 1 : 2
  return [...claims].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    if (a.transactionId !== b.transactionId)
      return (a.transactionId ?? '').localeCompare(b.transactionId ?? '')
    return b.asOf.localeCompare(a.asOf)
  })
}

/**
 * Content fingerprint. Re-running the graph refreshes the pending draft in place, so the
 * UI compares these to tell "the advice changed" apart from "nothing new to decide".
 */
export function proposalSignature(p: Proposal): string {
  return [p.title, p.rationale, ...p.actions.map((a) => `${a.kind}:${a.title}:${a.detail}`)].join(
    '|'
  )
}

/** Everything awaiting promotion to a fact. Only a person can clear this queue. */
export function unconfirmedClaims(claims: Claim[]): Claim[] {
  return claims.filter((c) => c.status !== 'confirmed' && !c.supersededById)
}
