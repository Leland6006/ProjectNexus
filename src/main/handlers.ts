// Maps allowlisted API method names to service calls. The acting user is held here in the
// main process, so the renderer can never claim to be someone else on a per-call basis.
// (Still a DEMO: switching accounts is unauthenticated by design.)

import { confirmClaim, mergeClaim } from '../shared/context.ts'
import { buildViewState, canSeeItem, canViewTransaction, effectiveOrgId } from '../shared/permissions.ts'
import { NO_LLM, runOrchestrator, approveProposal, rejectProposal, isDuplicateProposal, type LlmClient } from '../shared/orchestrator.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../shared/seed.ts'
import { NexusService, type ActorContext } from '../shared/service.ts'
import type { ApiMethod, ApiResult } from '../shared/api.ts'
import { API_METHODS } from '../shared/api.ts'
import { NexusError, type Database, type PaymentTerms } from '../shared/types.ts'

export interface Session {
  service: NexusService
  currentUserId: string
  /**
   * Organisation an external counsel is acting for, null for everybody else. A counsel
   * granted by both parties must pick one; see permissions.effectiveOrgId.
   * The service reads through the same object, so both stay in sync.
   */
  actor: ActorContext
}

export function createSession(db: Database, currentUserId: string, onChange: (s: Session) => void): Session {
  const session: Session = {
    service: null as unknown as NexusService,
    currentUserId,
    actor: { representingOrgId: null }
  }
  session.service = new NexusService(db, () => onChange(session), undefined, session.actor)
  return session
}

/**
 * No model is wired up in this build, so every judgement step is skipped and only the
 * deterministic finance analysis runs. Replace this with a real client (see
 * LlmClient) and the same graph lights up end to end.
 */
let llmClient: LlmClient | null = NO_LLM

export function setLlmClient(client: LlmClient | null): void {
  llmClient = client
}

const activeRuns = new WeakMap<Session, Map<string, symbol>>()

function analysisInputs(db: Database): string {
  return JSON.stringify([db.users, db.transactions, db.contracts, db.versions, db.costItems, db.cashAccounts, db.claims])
}

/** Runs the agent graph for a transaction and persists only a still-current result. */
export async function runAgentsFor(session: Session, transactionId: string): Promise<void> {
  const db = session.service.db
  const userId = session.currentUserId
  const representingOrgId = session.actor.representingOrgId
  const baseline = analysisInputs(db)
  const runs = activeRuns.get(session) ?? new Map<string, symbol>()
  activeRuns.set(session, runs)
  const token = Symbol()
  const key = `${userId}:${representingOrgId}:${transactionId}`
  runs.set(key, token)
  try {
    const result = await runOrchestrator({
      db,
      userId,
      transactionId,
      llm: llmClient,
      now: new Date().toISOString(),
      representingOrgId
    })
    if (runs.get(key) !== token || session.currentUserId !== userId ||
        session.actor.representingOrgId !== representingOrgId || analysisInputs(db) !== baseline) {
      throw new NexusError('CONFLICT', '分析期间数据或身份已变更，请重新分析')
    }
    const claimIds = new Map<string, string>()
    for (const c of result.claims) claimIds.set(c.id, mergeClaim(db.claims, c).claim.id)
    if (result.proposal) result.proposal.claimIds = [...new Set(result.proposal.claimIds.map((id) => claimIds.get(id) ?? id))]
    if (result.proposal) {
      if (isDuplicateProposal(db, result.proposal)) {
        // Refresh the draft already waiting: newest numbers, re-based on the current version.
        const existing = db.proposals.find(
          (p) => p.transactionId === result.proposal!.transactionId && p.orgId === result.proposal!.orgId && p.status === 'pending'
        )!
        Object.assign(existing, { ...result.proposal, id: existing.id, createdAt: existing.createdAt })
      } else {
        db.proposals.push(result.proposal)
      }
    }
    session.service.notifyChanged()
  } finally {
    if (runs.get(key) === token) runs.delete(key)
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new NexusError('INVALID_INPUT', '参数无效')
  return v
}

function obj<T>(v: unknown): T {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new NexusError('INVALID_INPUT', '参数无效')
  return v as T
}

export async function handleCall(session: Session, method: unknown, args: unknown[]): Promise<ApiResult> {
  try {
    if (typeof method !== 'string' || !(API_METHODS as readonly string[]).includes(method)) {
      throw new NexusError('INVALID_INPUT', '未知操作')
    }
    const s = session.service
    const me = session.currentUserId
    const m = method as ApiMethod
    switch (m) {
      case 'getState':
        break
      case 'switchUser': {
        const id = str(args[0])
        if (!s.db.users.some((u) => u.id === id)) throw new NexusError('NOT_FOUND', '账号不存在')
        session.currentUserId = id
        // A different account cannot inherit the previous one's delegated authority.
        session.actor.representingOrgId = null
        s.notifyChanged()
        break
      }
      case 'setRepresentingOrg': {
        const orgId = args[0] === null || args[0] === undefined ? null : str(args[0])
        const user = s.db.users.find((u) => u.id === me)
        if (!user || user.role !== 'external_counsel') {
          throw new NexusError('PERMISSION_DENIED', '只有外部律师可以切换代表的委托方')
        }
        if (orgId !== null) {
          const granted = s.db.transactions.some((t) =>
            t.counselGrants.some((g) => g.userId === me && g.grantedByOrgId === orgId)
          )
          if (!granted) throw new NexusError('PERMISSION_DENIED', '该律师未被此企业授权')
        }
        session.actor.representingOrgId = orgId
        s.notifyChanged()
        break
      }
      case 'resetDemo': {
        const fresh = createSeedDatabase()
        Object.assign(s.db, fresh)
        session.currentUserId = DEFAULT_USER_ID
        session.actor.representingOrgId = null
        s.notifyChanged()
        break
      }
      case 'createTransaction':
        s.createTransaction(me, obj(args[0]))
        break
      case 'updateTransaction':
        s.updateTransaction(me, str(args[0]), obj(args[1]))
        break
      case 'inviteCounterparty':
        s.inviteCounterparty(me, str(args[0]))
        break
      case 'acceptInvitation':
        s.acceptInvitation(me, str(args[0]))
        break
      case 'grantCounsel':
        s.grantCounsel(me, str(args[0]), str(args[1]))
        break
      case 'createContract':
        s.createContract(me, str(args[0]), str(args[1]), args[2] === undefined ? undefined : str(args[2]))
        break
      case 'shareContract':
        s.shareContract(me, str(args[0]))
        break
      case 'updateClauses':
        if (!Array.isArray(args[1])) throw new NexusError('INVALID_INPUT', '参数无效')
        s.updateClauses(me, str(args[0]), args[1])
        break
      case 'updatePaymentTerms': {
        const raw = args[1] === null || args[1] === undefined ? null : obj<PaymentTerms>(args[1])
        const contract = s.updatePaymentTerms(me, str(args[0]), raw)
        // Event-driven: a commercial change is analysed without being asked. Awaited so
        // the resulting draft is in the view state returned with this same call.
        await runAgentsFor(session, contract.transactionId)
        break
      }
      case 'runAgents': {
        // Manual re-run: the same graph, on demand, rather than only on a detected change.
        await runAgentsFor(session, str(args[0]))
        break
      }
      case 'approveProposal':
        approveProposal({ db: s.db, proposalId: str(args[0]), userId: me, at: new Date().toISOString(), representingOrgId: session.actor.representingOrgId })
        s.notifyChanged()
        break
      case 'rejectProposal':
        rejectProposal({ db: s.db, proposalId: str(args[0]), userId: me, at: new Date().toISOString(), representingOrgId: session.actor.representingOrgId })
        s.notifyChanged()
        break
      case 'confirmClaim': {
        // The one place an inference becomes company memory. Gated on the claim already
        // being visible to this user, so confirming cannot widen what they may read.
        const claim = s.db.claims.find((c) => c.id === str(args[0]))
        if (!claim) throw new NexusError('NOT_FOUND', '信息不存在')
        const user = s.db.users.find((u) => u.id === me)
        if (!user) throw new NexusError('NOT_FOUND', '账号不存在')
        const asOrgId = session.actor.representingOrgId
        if (claim.transactionId) {
          const tx = s.db.transactions.find((t) => t.id === claim.transactionId)
          if (!tx || !canViewTransaction(user, tx, asOrgId)) throw new NexusError('NOT_FOUND', '信息不存在')
          if (effectiveOrgId(user, tx, asOrgId) !== claim.orgId) throw new NexusError('PERMISSION_DENIED', '无权确认该信息')
          if (!canSeeItem(user, tx, claim, asOrgId)) throw new NexusError('PERMISSION_DENIED', '无权确认该信息')
        } else if (claim.orgId !== user.orgId) {
          throw new NexusError('PERMISSION_DENIED', '无权确认该信息')
        }
        Object.assign(claim, confirmClaim(claim, me, new Date().toISOString()))
        s.notifyChanged()
        break
      }
      case 'saveVersion':
        s.saveVersion(me, str(args[0]), str(args[1]), args[2] === undefined ? '' : str(args[2]))
        break
      case 'restoreVersion':
        s.restoreVersion(me, str(args[0]), str(args[1]))
        break
      case 'confirmFinal':
        s.confirmFinal(me, str(args[0]), str(args[1]))
        break
      case 'addComment': {
        const vis = str(args[3])
        if (vis !== 'shared' && vis !== 'internal' && vis !== 'counsel') throw new NexusError('INVALID_INPUT', '参数无效')
        s.addComment(me, str(args[0]), str(args[1]), str(args[2]), vis, args[4] == null ? null : str(args[4]))
        break
      }
      case 'createSuggestion':
        s.createSuggestion(me, str(args[0]), str(args[1]), str(args[2]), str(args[3]))
        break
      case 'resolveSuggestion':
        s.resolveSuggestion(me, str(args[0]), args[1] === true)
        break
      case 'sendMessage': {
        const vis = str(args[2])
        if (vis !== 'shared' && vis !== 'internal') throw new NexusError('INVALID_INPUT', '参数无效')
        s.sendMessage(me, str(args[0]), str(args[1]), vis)
        break
      }
      case 'createMilestone':
        s.createMilestone(me, obj(args[0]))
        break
      case 'updateMilestone':
        s.updateMilestone(me, str(args[0]), obj(args[1]))
        break
    }
    return {
      ok: true,
      state: buildViewState(s.db, session.currentUserId, {
        representingOrgId: session.actor.representingOrgId,
        // Local demo only: hand the renderer every account so it can switch between them.
        demoDirectory: true
      })
    }
  } catch (err) {
    if (err instanceof NexusError) return { ok: false, code: err.code, message: err.message }
    console.error('[handlers] unexpected error', err)
    return { ok: false, code: 'INTERNAL', message: '操作失败，请重试' }
  }
}
