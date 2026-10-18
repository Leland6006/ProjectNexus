// Nexus Context Engine — the shared company memory agents are allowed to read.
//
// Two rules shape everything here:
//
// 1. Agents are principals, not prompts. They never receive the database, only a bundle
//    assembled with the same permission functions the UI already trusts. An agent
//    invoked by user X can never see more than X can; internal counsel notes stay
//    invisible to the finance agent because it is never handed them, not because the
//    prompt asked nicely.
//
// 2. Facts, inferences and recommendations are different things and are stored
//    differently. A model saying "this client may pay late" must not become a fact the
//    next model builds on. Only a human promotion turns `inferred` into `confirmed`,
//    and an inference never overwrites a confirmed fact.

import { canSeeItem, canViewContract, canViewTransaction, effectiveOrgId } from './permissions.ts'
import { NexusError, type Claim, type Database, type DomainEvent, type Transaction, type User } from './types.ts'

export type AgentId = 'legal' | 'finance' | 'ops' | 'main'

export interface AgentScope {
  /** Claim key prefixes the agent is entitled to. `'*'` means everything visible. */
  claimPrefixes: string[]
  /** Whether the agent may read clause prose. Free-form discussion is never included. */
  readsClauses: boolean
}

/**
 * What each specialist is allowed to see. The finance agent gets numbers, not legal
 * reasoning; the legal agent gets clause text, not cost lines. Narrower bundles are
 * cheaper, safer, and produce better answers.
 */
export const AGENT_SCOPE: Record<AgentId, AgentScope> = {
  legal: { claimPrefixes: ['payment.', 'contract.', 'delivery.', 'risk.'], readsClauses: true },
  finance: { claimPrefixes: ['payment.', 'cost.', 'cash.'], readsClauses: false },
  ops: { claimPrefixes: ['payment.', 'cost.', 'delivery.', 'milestone.', 'ops.'], readsClauses: false },
  main: { claimPrefixes: ['*'], readsClauses: true }
}

export interface AgentContext {
  agentId: AgentId
  transactionId: string
  orgId: string
  claims: Claim[]
  /** Clause prose, or null when this agent is not entitled to it. */
  clauses: { id: string; title: string; body: string }[] | null
  event: DomainEvent | null
}

export interface ContextOptions {
  representingOrgId?: string | null
  event?: DomainEvent | null
}

function claimInScope(claim: Claim, scope: AgentScope): boolean {
  if (scope.claimPrefixes.includes('*')) return true
  return scope.claimPrefixes.some((p) => claim.key.startsWith(p))
}

/** Claims for one transaction that the acting user may see. */
export function visibleClaims(
  db: Database,
  user: User,
  tx: Transaction,
  asOrgId?: string | null
): Claim[] {
  return db.claims.filter((c) => {
    if (c.transactionId !== null && c.transactionId !== tx.id) return false
    return canSeeItem(user, tx, { orgId: c.orgId, visibility: c.visibility }, asOrgId)
  })
}

export function buildAgentContext(
  db: Database,
  userId: string,
  agentId: AgentId,
  transactionId: string,
  opts: ContextOptions = {}
): AgentContext {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new NexusError('NOT_FOUND', '账号不存在')
  const tx = db.transactions.find((t) => t.id === transactionId)
  if (!tx) throw new NexusError('NOT_FOUND', '交易项目不存在或无权访问')
  const asOrgId = opts.representingOrgId ?? null
  if (!canViewTransaction(user, tx, asOrgId)) {
    throw new NexusError('NOT_FOUND', '交易项目不存在或无权访问')
  }
  const orgId = effectiveOrgId(user, tx, asOrgId)!
  const scope = AGENT_SCOPE[agentId]

  const claims = visibleClaims(db, user, tx, asOrgId).filter((c) => claimInScope(c, scope))

  // Only the contract the user can already see, and only if this agent reads prose.
  let clauses: AgentContext['clauses'] = null
  if (scope.readsClauses) {
    const contract = db.contracts
      .filter((c) => c.transactionId === tx.id && canViewContract(user, tx, c, asOrgId))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
    if (contract) clauses = contract.clauses.map((c) => ({ id: c.id, title: c.title, body: c.body }))
  }

  return { agentId, transactionId, orgId, claims, clauses, event: opts.event ?? null }
}

// --- Claim lifecycle -------------------------------------------------------------

/** Only a human can turn an inference into a fact. */
export function canPromote(claim: Claim): boolean {
  return claim.status !== 'confirmed'
}

export function confirmClaim(claim: Claim, userId: string, at: string): Claim {
  if (!canPromote(claim)) throw new NexusError('CONFLICT', '该信息已经是已确认事实')
  return { ...claim, status: 'confirmed', confirmedBy: userId, confirmedAt: at, asOf: at }
}

export type MergeAction = 'added' | 'replaced' | 'ignored'

/**
 * Store a claim under its semantic key.
 *
 * An inference never replaces a confirmed fact — that is the firewall against agents
 * quietly rewriting company memory. A newer inference replaces an older one and marks
 * the old record superseded so the trail stays auditable.
 */
export function mergeClaim(claims: Claim[], incoming: Claim): { claim: Claim; action: MergeAction } {
  const existing = claims.find(
    (c) =>
      c.id !== incoming.id &&
      c.key === incoming.key &&
      c.orgId === incoming.orgId &&
      (c.transactionId ?? null) === (incoming.transactionId ?? null) &&
      !c.supersededById
  )
  if (!existing) {
    claims.push(incoming)
    return { claim: incoming, action: 'added' }
  }
  if (existing.status === 'confirmed' && incoming.status !== 'confirmed') {
    return { claim: existing, action: 'ignored' }
  }
  existing.supersededById = incoming.id
  claims.push(incoming)
  return { claim: incoming, action: 'replaced' }
}

/**
 * Split a bundle into what may be reasoned from and what may not.
 * Agents must build findings on confirmed facts only; inferences are outputs, never
 * inputs for another agent. This is what stops models from citing each other's guesses.
 */
export function selectPremises(claims: Claim[]): { premises: Claim[]; excluded: Claim[] } {
  const premises: Claim[] = []
  const excluded: Claim[] = []
  for (const c of claims) {
    if (c.status === 'confirmed') premises.push(c)
    else excluded.push(c)
  }
  return { premises, excluded }
}

/** Renders a bundle for a prompt. Numbers carry their status so the model sees it too. */
export function renderContext(ctx: AgentContext): string {
  const lines: string[] = []
  lines.push(`# 交易上下文（${ctx.agentId} 视角，企业 ${ctx.orgId}）`)
  if (ctx.event) {
    lines.push('')
    lines.push(`## 触发事件：${ctx.event.summary}`)
    for (const [k, v] of Object.entries(ctx.event.payload)) lines.push(`- ${k}: ${v}`)
  }
  lines.push('')
  lines.push('## 已确认事实')
  const { premises, excluded } = selectPremises(ctx.claims)
  if (premises.length === 0) lines.push('- （无）')
  for (const c of premises) {
    lines.push(`- ${c.label}: ${c.value}${c.unit ? ` ${c.unit}` : ''}  [来源: ${c.source.kind}]`)
  }
  if (excluded.length > 0) {
    lines.push('')
    lines.push('## 推断与建议（不可作为事实引用）')
    for (const c of excluded) lines.push(`- ${c.label}: ${c.value}`)
  }
  if (ctx.clauses) {
    lines.push('')
    lines.push('## 条款')
    for (const c of ctx.clauses) lines.push(`- ${c.title}`)
  }
  return lines.join('\n')
}
