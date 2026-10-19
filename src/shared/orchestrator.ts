// Cross-agent orchestration.
//
// This is a deterministic graph with three labelled model calls, not four agents
// chatting until something sensible comes out. The routing, the arithmetic and the
// permission filtering are plain code; models are only used where judgement is actually
// needed (legal and operational reading of a change) and for the final synthesis.
//
// The finance step never calls a model. It cannot hallucinate a funding gap it did not
// compute, because it does not get the chance.

import { buildAgentContext, mergeClaim, renderContext, selectPremises, type AgentId, type AgentContext } from './context.ts'
import { detectPaymentTermsChange, latestVersionPair } from './events.ts'
import { describeForecast, forecastCashflow } from './finance.ts'
import { buildViewState, canSeeItem, canViewContract, canViewTransaction, effectiveOrgId } from './permissions.ts'
import {
  NexusError,
  type Activity,
  type Claim,
  type Contract,
  type Database,
  type DomainEvent,
  type Proposal,
  type ProposedAction,
  type Suggestion,
  type Transaction,
  type User
} from './types.ts'

export interface LlmRequest {
  system: string
  user: string
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>
}

/** Stand-in for tests and for the local demo that has no model wired up. */
export const NO_LLM: LlmClient = { complete: async () => '' }

/** Finding emitted when a judgement step is skipped because no model is configured. */
const NO_MODEL = '未接入模型，跳过该专业视角。'

export function routeAgents(event: DomainEvent | null): AgentId[] {
  if (!event) return []
  switch (event.type) {
    case 'payment_terms_changed':
      return ['finance', 'legal', 'ops']
    case 'cost_committed':
      return ['finance', 'ops']
    case 'milestone_delayed':
      return ['ops', 'finance']
    default:
      return []
  }
}

export interface AgentBrief {
  agentId: AgentId
  findings: string[]
  recommendation: string | null
  claims: Claim[]
}

export interface OrchestrationResult {
  event: DomainEvent | null
  briefs: AgentBrief[]
  /** Claims to persist; caller writes them through the store. */
  claims: Claim[]
  proposal: Proposal | null
}

export interface RunOptions {
  db: Database
  userId: string
  transactionId: string
  llm?: LlmClient | null
  now: string
  makeId?: (prefix: string) => string
  representingOrgId?: string | null
  /** Supply a pre-detected event; otherwise the last two versions are diffed. */
  event?: DomainEvent | null
}

function uid(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`
}

function parseBullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''))
    .filter((l) => l.length > 0)
}

function makeClaim(args: {
  id: string
  orgId: string
  transactionId: string
  key: string
  label: string
  value: string
  numeric: number | null
  unit?: string | null
  status: Claim['status']
  source: Claim['source']
  asOf: string
}): Claim {
  return {
    id: args.id,
    orgId: args.orgId,
    transactionId: args.transactionId,
    key: args.key,
    label: args.label,
    value: args.value,
    numeric: args.numeric,
    unit: args.unit ?? null,
    status: args.status,
    source: args.source,
    asOf: args.asOf,
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  }
}

function primaryContract(db: Database, tx: Transaction, user: User, asOrgId: string | null): Contract | null {
  return db.contracts
    .filter((c) => c.transactionId === tx.id && canViewContract(user, tx, c, asOrgId))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null
}

function latestVersionId(db: Database, contractId: string | null): string | null {
  if (!contractId) return null
  const forContract = db.versions.filter((v) => v.contractId === contractId).sort((a, b) => a.number - b.number)
  return forContract.length ? forContract[forContract.length - 1].id : null
}

async function runSpecialist(
  agentId: AgentId,
  args: {
    db: Database
    userId: string
    transactionId: string
    asOrgId: string | null
    event: DomainEvent | null
    ctx: AgentContext
    llm: LlmClient | null
    now: string
    makeId: (prefix: string) => string
    contract: Contract | null
    orgId: string
  }
): Promise<AgentBrief> {
  const { ctx, llm, now, makeId, contract, orgId, event, db } = args

  // Finance is arithmetic. No model call, no chance of inventing a number.
  if (agentId === 'finance') {
    const claims: Claim[] = []
    const findings: string[] = []
    const terms = contract?.paymentTerms ?? null

    if (!terms) {
      findings.push('合同尚未填写结构化付款条款，无法测算资金缺口。')
      return { agentId, findings, recommendation: null, claims }
    }

    const costs = db.costItems.filter((c) => c.transactionId === args.transactionId && c.orgId === orgId)
    const account = db.cashAccounts.find((a) => a.orgId === orgId) ?? null
    const forecast = forecastCashflow({ transaction: db.transactions.find((t) => t.id === args.transactionId)!, terms, costs, account })

    const prepay = Math.round(db.transactions.find((t) => t.id === args.transactionId)!.amount * terms.prepayRate * 100) / 100
    claims.push(
      makeClaim({
        id: makeId('cl'),
        orgId,
        transactionId: args.transactionId,
        key: 'payment.prepay_amount',
        label: '预付款金额',
        value: `¥${prepay.toLocaleString('zh-CN')}`,
        numeric: prepay,
        unit: 'CNY',
        status: 'confirmed',
        source: { kind: 'contract', ref: contract?.id, detail: '按合同金额与预付款比例计算' },
        asOf: now
      })
    )
    claims.push(
      makeClaim({
        id: makeId('cl'),
        orgId,
        transactionId: args.transactionId,
        key: 'cash.gap',
        label: '预计资金缺口',
        value: forecast.shortfall > 0 ? `¥${forecast.shortfall.toLocaleString('zh-CN')}` : '无缺口',
        numeric: forecast.shortfall,
        unit: 'CNY',
        status: 'inferred',
        source: { kind: 'agent', ref: 'finance', detail: '按假设的收付时点测算' },
        asOf: now
      })
    )

    findings.push(
      `预付款 ¥${prepay.toLocaleString('zh-CN')}，可动用现金 ¥${(account?.openingBalance ?? 0).toLocaleString('zh-CN')}。`
    )
    findings.push(describeForecast(forecast))
    if (event?.type === 'payment_terms_changed') {
      const delta = Number(event.payload.prepayAmountDelta ?? 0)
      findings.push(`本次变更使预付款${delta < 0 ? '减少' : '增加'} ¥${Math.abs(delta).toLocaleString('zh-CN')}。`)
    }

    const recommendation = forecast.shortfall > 0 ? '建议改分阶段收款或提高预付款比例。' : null
    return { agentId, findings, recommendation, claims }
  }

  if (!llm) {
    return { agentId, findings: [NO_MODEL], recommendation: null, claims: [] }
  }

  const system =
    agentId === 'legal'
      ? '你是企业的法务顾问。只依据给定的已确认事实作答，逐条输出风险，不要编造条款内容，不要给出确定性法律结论。'
      : '你是企业的经营顾问。只依据给定的已确认事实作答，逐条给出可执行的经营应对，不要编造数据。'
  const user = `${renderContext(ctx)}\n\n请以「- 」开头的列表输出 3 条以内的结论。`
  const text = await llm.complete({ system, user })
  const findings = parseBullets(text)

  const claims = findings.slice(0, 3).map((f, i) =>
    makeClaim({
      id: makeId('cl'),
      orgId,
      transactionId: args.transactionId,
      key: `${agentId === 'legal' ? 'risk.legal' : 'ops.plan'}.${i}`,
      label: agentId === 'legal' ? '法务风险提示' : '经营应对建议',
      value: f,
      numeric: null,
      status: agentId === 'legal' ? 'inferred' : 'recommended',
      source: { kind: 'agent', ref: agentId },
      asOf: now
    })
  )

  return { agentId, findings, recommendation: findings[0] ?? null, claims }
}

export async function runOrchestrator(opts: RunOptions): Promise<OrchestrationResult> {
  // Freeze every input before the first model await, including the version baseline.
  const db = structuredClone(opts.db)
  const { userId, transactionId } = opts
  const makeId = opts.makeId ?? uid
  const llm = opts.llm ?? null
  const now = opts.now

  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new NexusError('NOT_FOUND', '账号不存在')
  const tx = db.transactions.find((t) => t.id === transactionId)
  if (!tx || !canViewTransaction(user, tx, opts.representingOrgId ?? null)) {
    throw new NexusError('NOT_FOUND', '交易项目不存在或无权访问')
  }
  if (user.role === 'external_counsel') {
    throw new NexusError('PERMISSION_DENIED', '企业内部综合分析仅限企业成员运行')
  }
  const asOrgId = opts.representingOrgId ?? null
  const orgId = effectiveOrgId(user, tx, asOrgId)!
  const view = buildViewState(db, userId, { representingOrgId: asOrgId })
  const contract = primaryContract(db, tx, user, asOrgId)
  // Apply the same visibility boundary to event detection and deterministic finance.
  db.versions = view.versions
  db.costItems = view.costItems
  db.cashAccounts = view.cashAccounts
  const baseVersionId = latestVersionId(db, contract?.id ?? null)

  let event: DomainEvent | null = null
  if (opts.event !== undefined) {
    event = opts.event
  } else if (contract) {
    const [prev, next] = latestVersionPair(db.versions, contract.id)
    if (next) event = detectPaymentTermsChange({ transaction: tx, contract, previous: prev, next, at: now, makeId })
  }

  const agents = routeAgents(event)
  if (agents.length === 0) return { event, briefs: [], claims: [], proposal: null }

  const briefs: AgentBrief[] = []
  const claims: Claim[] = []

  for (const agentId of agents) {
    const ctx = buildAgentContext(db, userId, agentId, transactionId, {
      representingOrgId: asOrgId,
      event
    })
    const brief = await runSpecialist(agentId, {
      db,
      userId,
      transactionId,
      asOrgId,
      event,
      ctx,
      llm,
      now,
      makeId,
      contract,
      orgId
    })
    briefs.push(brief)
    for (const c of brief.claims) mergeClaim(claims, c)
  }

  // Synthesis. Uses confirmed premises only — never another agent's inference.
  const { premises } = selectPremises(claims)

  let title = event?.summary ?? '需要关注的变化'
  // "No model configured" is a build fact, not a finding a user should act on.
  const usableFindings = briefs.flatMap((b) => b.findings).filter((f) => f !== NO_MODEL)
  let rationale = usableFindings.slice(0, 6).join('\n')
  let actions: ProposedAction[] = []

  if (llm) {
    const system =
      '你是 Nexus 主顾问，负责整合法务、财务、经营三个视角。只依据给定的已确认事实，输出一条对用户最有用的建议。'
    const text = await llm.complete({
      system,
      user: `事件：${event?.summary ?? '（无）'}\n\n已确认事实：\n${
        premises.map((c) => `- ${c.label}: ${c.value}`).join('\n') || '- （无）'
      }\n\n各专业视角：\n${usableFindings.map((f) => `- ${f}`).join('\n')}`
    })
    const lines = parseBullets(text)
    if (lines.length > 0) {
      title = lines[0].slice(0, 80)
      rationale = lines.slice(1).join('\n') || rationale
    }
    actions = lines.slice(1, 4).map((l) => ({ kind: 'add_task' as const, title: l.slice(0, 80), detail: l }))
  }

  if (actions.length === 0) {
    actions = briefs
      .filter((b) => b.recommendation)
      .map((b) => ({
        kind: 'add_task' as const,
        title: b.recommendation!.slice(0, 80),
        detail: `${b.agentId}: ${b.recommendation!}`
      }))
  }

  const proposal: Proposal | null =
    actions.length > 0
      ? {
          id: makeId('pp'),
          transactionId,
          contractId: contract?.id ?? null,
          orgId,
          title,
          rationale,
          actions,
          claimIds: claims.map((c) => c.id),
          eventId: event?.id ?? null,
          status: 'pending',
          createdBy: 'agent:main',
          createdAt: now,
          resolvedBy: null,
          resolvedAt: null,
          baseVersionId
        }
      : null

  return { event, briefs, claims, proposal }
}

/**
 * A transaction has at most one draft waiting for a person. Re-running the graph is a
 * refresh, not a new item: the review queue is a decision list, not an archive, and a
 * second near-identical card is the fastest way to make people stop trusting it.
 * Decided drafts are history and never block a new one.
 */
export function isDuplicateProposal(db: Database, proposal: Proposal): boolean {
  return db.proposals.some(
    (p) =>
      p.id !== proposal.id &&
      p.transactionId === proposal.transactionId &&
      p.orgId === proposal.orgId &&
      p.status === 'pending'
  )
}

// --- Human confirmation ----------------------------------------------------------

export interface ApprovalResult {
  proposal: Proposal
  /** The evidence the decision cited, in its unchanged state. Never promoted here. */
  claims: Claim[]
  suggestions: Suggestion[]
  activity: Activity
}

function isStale(db: Database, proposal: Proposal): boolean {
  if (!proposal.contractId || !proposal.baseVersionId) return false
  return latestVersionId(db, proposal.contractId) !== proposal.baseVersionId
}

function authorizeProposal(db: Database, proposalId: string, userId: string, asOrgId?: string | null): Proposal {
  const user = db.users.find((u) => u.id === userId)
  const proposal = db.proposals.find((p) => p.id === proposalId)
  const tx = proposal && db.transactions.find((t) => t.id === proposal.transactionId)
  if (!user || !proposal || !tx) throw new NexusError('NOT_FOUND', '建议不存在')
  if (user.role === 'external_counsel' || effectiveOrgId(user, tx, asOrgId) !== proposal.orgId) {
    throw new NexusError('PERMISSION_DENIED', '无权处理该企业的内部建议')
  }
  if (proposal.contractId) {
    const contract = db.contracts.find((c) => c.id === proposal.contractId)
    if (!contract || contract.transactionId !== tx.id || !canViewContract(user, tx, contract, asOrgId)) {
      throw new NexusError('PERMISSION_DENIED', '无权访问建议关联的合同')
    }
  }
  if (proposal.status !== 'pending') throw new NexusError('CONFLICT', '该建议已处理')
  return proposal
}

/**
 * Nothing an agent drafts takes effect on its own.
 *
 * Adopting a plan is NOT confirming its premises. A forecast ("cash gap of ¥342,000")
 * stays a forecast after the user decides to act on it, and a recommendation stays a
 * recommendation. Approval therefore leaves every cited claim exactly as it was; the
 * only way a claim becomes a confirmed fact is an explicit `confirmClaim` on that claim.
 */
export function approveProposal(args: {
  db: Database
  proposalId: string
  userId: string
  at: string
  makeId?: (prefix: string) => string
  representingOrgId?: string | null
}): ApprovalResult {
  const { db, proposalId, userId, at } = args
  const makeId = args.makeId ?? uid
  const proposal = authorizeProposal(db, proposalId, userId, args.representingOrgId)
  const user = db.users.find((u) => u.id === userId)!
  const tx = db.transactions.find((t) => t.id === proposal.transactionId)!
  // Validate the entire evidence set before mutating any claim or proposal.
  for (const id of proposal.claimIds) {
    const claim = db.claims.find((c) => c.id === id)
    if (!claim || claim.supersededById || claim.orgId !== proposal.orgId ||
        (claim.transactionId !== null && claim.transactionId !== tx.id)) {
      throw new NexusError('CONFLICT', '建议依据缺失或已被替代，请重新生成建议')
    }
    if (!canSeeItem(user, tx, claim, args.representingOrgId)) {
      throw new NexusError('PERMISSION_DENIED', '无权确认建议依据')
    }
  }

  if (isStale(db, proposal)) {
    throw new NexusError('CONFLICT', '合同已在建议生成后被修改，请重新生成建议')
  }

  // Evidence is reported back unchanged so callers can show what the decision rested on.
  const cited: Claim[] = db.claims.filter((c) => proposal.claimIds.includes(c.id))

  const suggestions: Suggestion[] = []
  const contract = proposal.contractId ? db.contracts.find((c) => c.id === proposal.contractId) : undefined
  for (const action of proposal.actions) {
    if (!action.clauseId || !action.proposedBody || !contract) continue
    const clause = contract.clauses.find((c) => c.id === action.clauseId)
    if (!clause) continue
    const orgId = effectiveOrgId(user, tx)!
    suggestions.push({
      id: makeId('sg'),
      contractId: contract.id,
      clauseId: clause.id,
      authorId: userId,
      orgId,
      originalBody: clause.body,
      proposedBody: action.proposedBody,
      reason: action.detail,
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: at
    })
  }
  db.suggestions.push(...suggestions)

  proposal.status = 'approved'
  proposal.resolvedBy = userId
  proposal.resolvedAt = at

  const activity: Activity = {
    id: makeId('ac'),
    transactionId: proposal.transactionId,
    contractId: proposal.contractId,
    actorId: userId,
    orgId: proposal.orgId,
    type: 'proposal_approved',
    summary: `${user.name} 采纳了建议「${proposal.title}」`,
    visibility: 'internal',
    createdAt: at
  }
  db.activities.push(activity)

  return { proposal, claims: cited, suggestions, activity }
}

export function rejectProposal(args: { db: Database; proposalId: string; userId: string; at: string; representingOrgId?: string | null }): Proposal {
  const proposal = authorizeProposal(args.db, args.proposalId, args.userId, args.representingOrgId)
  proposal.status = 'rejected'
  proposal.resolvedBy = args.userId
  proposal.resolvedAt = args.at
  return proposal
}
