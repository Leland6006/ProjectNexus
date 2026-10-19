import { extractContractText, identifyContractFields } from './contractImport.ts'
import { createHash } from 'node:crypto'
import { workflowMember } from '../shared/workflows.ts'
// Maps allowlisted API method names to service calls. The acting user is held here in the
// main process, so the renderer can never claim to be someone else on a per-call basis.
// (Still a DEMO: switching accounts is unauthenticated by design.)

import type { AiSettings } from './ai.ts'
import { createDeepSeekRuntime, createDeepSeekLlm } from './ai.ts'
import type { ChatProgress } from '../shared/api.ts'
import { confirmClaim, mergeClaim } from '../shared/context.ts'
import { buildViewState, canSeeItem, canViewTransaction, effectiveOrgId } from '../shared/permissions.ts'
import { runOrchestrator, approveProposal, rejectProposal, isDuplicateProposal, type LlmClient } from '../shared/orchestrator.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../shared/seed.ts'
import { NO_RUNTIME, type NexusRuntime, type RuntimeReply } from '../shared/chat.ts'
import { NexusService, type ActorContext } from '../shared/service.ts'
import type { ApiMethod, ApiResult } from '../shared/api.ts'
import { API_METHODS } from '../shared/api.ts'
import { NexusError, type Database, type PaymentTerms, type AnalysisRun, type DomainEvent, type ViewState } from '../shared/types.ts'

export interface Session {
  selectContractFile?: () => Promise<{ fileName: string; bytes: Uint8Array } | null>
  analysisControllers: Map<string, AbortController>
  onWorkflowProgress?: (state: ViewState) => void
  generation: number
  onChatProgress?: (event: ChatProgress) => void
  aiSettings?: AiSettings
  chatRun?: { controller: AbortController; conversationId: string; userId: string }
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
    generation: 0,
    analysisControllers: new Map(),
    service: null as unknown as NexusService,
    currentUserId,
    actor: { representingOrgId: null }
  }
  session.service = new NexusService(db, () => onChange(session), undefined, session.actor)
  return session
}

/**
 * Until the user configures a provider, every judgement step is skipped and only the
 * deterministic finance analysis runs. Replace this with a real client (see
 * LlmClient) and the same graph lights up end to end.
 */
let llmClient: LlmClient | null = null

export function setLlmClient(client: LlmClient | null): void {
  llmClient = client
}

function analysisInputs(session: Session): string {
  const v = buildViewState(session.service.db, session.currentUserId, { representingOrgId: session.actor.representingOrgId })
  return createHash('sha256').update(JSON.stringify([v.currentUserId, v.organizations, v.transactions, v.contracts, v.versions, v.costItems, v.cashAccounts, v.claims, v.milestones, v.cashPlans, v.cashEntries, v.invoiceCases])).digest('hex')
}
function publishWorkflow(session: Session): void {
  session.service.notifyChanged()
  session.onWorkflowProgress?.(sessionView(session))
}
export function pauseAnalyses(session: Session): void {
  for (const [id, controller] of session.analysisControllers) {
    controller.abort()
    const run = session.service.db.analysisRuns.find((r) => r.id === id)
    if (run?.status === 'running') { run.status = 'paused'; run.error = '运行已暂停，确认后可恢复'; run.updatedAt = new Date().toISOString() }
  }
  if (session.analysisControllers.size) session.service.notifyChanged()
}

export async function runAgentsFor(session: Session, transactionId: string, options: { event?: DomainEvent; resumeId?: string } = {}): Promise<void> {
  const db = session.service.db
  const userId = session.currentUserId
  const member = workflowMember(db, userId, transactionId)
  const representingOrgId = session.actor.representingOrgId
  const generation = session.generation
  const baseline = analysisInputs(session)
  const provider = llmClient ? `model:${runtime.id}` : 'local-finance'
  let run: AnalysisRun
  if (options.resumeId) {
    const existing = db.analysisRuns.find((r) => r.id === options.resumeId && r.orgId === member.orgId && r.transactionId === transactionId && r.createdBy === userId)
    if (!existing || !['paused', 'failed'].includes(existing.status)) throw new NexusError('CONFLICT', '分析不存在、无权恢复或已结束')
    if (session.analysisControllers.has(existing.id)) throw new NexusError('CONFLICT', '上一轮正在停止，请稍后恢复')
    if (existing.sourceRevision !== baseline || existing.provider !== provider) {
      existing.status = 'stale'; existing.error = '源数据或模型配置已变化，请发起新分析'; publishWorkflow(session)
      throw new NexusError('CONFLICT', existing.error)
    }
    run = existing
    run.status = 'running'; run.error = null
  } else {
    // A newer run for the same project supersedes the old one. Its late result cannot write.
    for (const old of db.analysisRuns) if (old.orgId === member.orgId && old.transactionId === transactionId && old.status === 'running') {
      session.analysisControllers.get(old.id)?.abort()
      old.status = 'cancelled'; old.error = '已被更新的分析替代'
    }
    run = { id: `run_${crypto.randomUUID()}`, orgId: member.orgId, transactionId, createdBy: userId,
      status: 'running', trigger: options.event?.summary ?? '付款安排协同分析', event: options.event ?? null, sourceRevision: baseline,
      provider, steps: [], proposalId: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    db.analysisRuns.push(run)
  }
  const controller = new AbortController()
  session.analysisControllers.set(run.id, controller)
  const active = () => !controller.signal.aborted && run.status === 'running' && session.generation === generation && session.currentUserId === userId && session.actor.representingOrgId === representingOrgId
  publishWorkflow(session)
  try {
    const result = await runOrchestrator({ db, userId, transactionId, llm: llmClient, now: new Date().toISOString(), representingOrgId,
      event: options.resumeId ? run.event : options.event,
      signal: controller.signal, cachedSteps: options.resumeId ? structuredClone(run.steps) : [],
      onEvent: (event) => { if (active()) { run.event = event; run.trigger = event?.summary ?? run.trigger } },
      onStep: (step) => {
        if (!active()) return
        if (analysisInputs(session) !== baseline) throw new NexusError('CONFLICT', '分析期间数据已变化')
        const index = run.steps.findIndex((s) => s.agentId === step.agentId)
        if (index < 0) run.steps.push(step)
        else run.steps[index] = step
        run.updatedAt = new Date().toISOString()
        publishWorkflow(session)
      }
    })
    if (!active() || analysisInputs(session) !== baseline) throw new NexusError('CONFLICT', '分析期间数据或身份已变更，请重新分析')
    const claimIds = new Map<string, string>()
    for (const c of result.claims) claimIds.set(c.id, mergeClaim(db.claims, c).claim.id)
    if (result.proposal) {
      result.proposal.claimIds = [...new Set(result.proposal.claimIds.map((id) => claimIds.get(id) ?? id))]
      result.proposal.analysisRunId = run.id
      if (isDuplicateProposal(db, result.proposal)) {
        const existing = db.proposals.find((p) => p.transactionId === transactionId && p.orgId === member.orgId && p.status === 'pending')!
        Object.assign(existing, { ...result.proposal, id: existing.id, createdAt: existing.createdAt })
        run.proposalId = existing.id
      } else { db.proposals.push(result.proposal); run.proposalId = result.proposal.id }
    }
    run.status = 'completed'; run.updatedAt = new Date().toISOString()
    publishWorkflow(session)
  } catch (err) {
    if (run.status === 'running') {
      run.status = controller.signal.aborted ? 'paused' : analysisInputs(session) !== baseline ? 'stale' : 'failed'
      run.error = run.status === 'stale' ? '源数据已变化，请重新分析' : run.status === 'paused' ? '分析已暂停，可恢复' : '分析未完成，可恢复后重试未完成节点'
      run.updatedAt = new Date().toISOString()
      publishWorkflow(session)
    }
    throw new NexusError('CONFLICT', run.error ?? '分析已中断')
  } finally { session.analysisControllers.delete(run.id) }
}

/**
 * What answers Nexus conversations. Nothing is connected in this build, so every
 * message gets an honest "not connected" notice. A model API or DeepSeek Harness
 * adapter would be installed here (see chat.ts NexusRuntime); it still has to go
 * through NexusService for anything it wants to change.
 */
let runtime: NexusRuntime = NO_RUNTIME

export function setRuntime(next: NexusRuntime | null): void {
  runtime = next ?? NO_RUNTIME
}

function sessionView(session: Session) {
  return buildViewState(session.service.db, session.currentUserId, { representingOrgId: session.actor.representingOrgId, demoDirectory: true, runtime: { id: runtime.id, connected: runtime.connected } })
}

async function replyFor(session: Session, conversationId: string, text: string): Promise<void> {
  const userId = session.currentUserId
  const generation = session.generation
  const controller = new AbortController()
  const run = { controller, conversationId, userId }
  session.chatRun = run
  const active = () => session.generation === generation && session.currentUserId === userId && session.chatRun === run
  const emit = (stage: ChatProgress['stage'], body = '') => {
    if (active()) session.onChatProgress?.({ userId, conversationId, stage, body, ...(stage !== 'delta' ? { state: sessionView(session) } : {}) })
  }
  const input = analysisInputs(session)
  let reply: RuntimeReply
  emit('start')
  try {
    const view = structuredClone(sessionView(session))
    // Runtime receives no demo directory, private discussions, unrelated chats or database.
    view.demoAccounts = null
    view.comments = []; view.messages = []; view.activities = []
    const history = view.chatMessages.filter((m) => m.conversationId === conversationId)
    view.chatMessages = []; view.conversations = []
    reply = await runtime.reply({ conversationId, userId, text, view, history, signal: controller.signal, onDelta: (body) => emit('delta', body) })
    if (controller.signal.aborted) throw new Error('已停止生成')
    const latest = analysisInputs(session)
    if (latest !== input) reply = { role: 'system', body: '分析期间企业数据已变化，本次回答未保存，请按最新数据重试。', runtime: runtime.id }
  } catch (err) {
    const detail = controller.signal.aborted ? '已停止生成。' : err instanceof Error && /^(API Key|模型|连接中断|回答超出|分析步骤|缺少授权)/.test(err.message) ? err.message : '连接 AI 时出错或超时，请检查网络和设置后重试。'
    reply = { role: 'system', body: `${detail} 你的消息已保存，业务数据未修改。`, runtime: runtime.id }
  }
  if (active()) {
    session.service.recordRuntimeReply(userId, conversationId, reply)
    emit('end')
  }
  if (session.chatRun === run) session.chatRun = undefined
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
    let notice: string | undefined
    const m = method as ApiMethod
    switch (m) {
      case 'createCounterparty': s.createCounterparty(me, obj(args[0])); break
      case 'requestInternalReview': s.requestInternalReview(me, str(args[0]), str(args[1])); break
      case 'decideInternalReview': s.decideInternalReview(me, str(args[0]), obj(args[1])); break
      case 'confirmContractImport': s.confirmContractImport(me, str(args[0]), obj(args[1])); break
      case 'selectContractImport': {
        const user = s.db.users.find((u) => u.id === me)
        if (!user || user.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '当前账号不能导入合同')
        if (!session.selectContractFile) throw new NexusError('INVALID_INPUT', '当前环境没有文件选择器')
        const generation = session.generation
        const selected = await session.selectContractFile()
        if (!selected) { notice = '已取消选择文件'; break }
        const rawText = await extractContractText(selected.fileName, selected.bytes)
        if (session.generation !== generation || session.currentUserId !== me) throw new NexusError('CONFLICT', '账号已切换，请重新导入')
        s.stageContractImport(me, { fileName: selected.fileName, rawText, ...identifyContractFields(rawText) })
        notice = '已生成待核对草稿，尚未创建业务或修改资金计划'
        break
      }
      case 'saveCashPlan': s.saveCashPlan(me, obj(args[0])); break
      case 'cancelCashPlan': s.cancelCashPlan(me, str(args[0]), Number(args[1])); break
      case 'recordCashEntry': s.recordCashEntry(me, obj(args[0])); break
      case 'voidCashEntry': s.voidCashEntry(me, str(args[0]), str(args[1])); break
      case 'saveInvoiceCase': s.saveInvoiceCase(me, obj(args[0])); break
      case 'advanceInvoiceCase': s.advanceInvoiceCase(me, str(args[0]), obj(args[1])); break
      case 'getState':
        break
      case 'createTask': s.createTask(me, obj(args[0])); break
      case 'updateTask': s.updateTask(me, str(args[0]), obj(args[1])); break
      case 'completeTaskStep': s.completeTaskStep(me, str(args[0]), obj(args[1])); break
      case 'pauseAnalysis': {
        const run = s.db.analysisRuns.find((r) => r.id === str(args[0]) && r.createdBy === me)
        if (!run) throw new NexusError('NOT_FOUND', '分析不存在或无权操作')
        workflowMember(s.db, me, run.transactionId, run.orgId)
        const controller = session.analysisControllers.get(run.id)
        if (!controller || run.status !== 'running') throw new NexusError('CONFLICT', '分析不在运行中')
        run.status = 'paused'; run.error = '用户暂停分析'; run.updatedAt = new Date().toISOString(); controller.abort(); publishWorkflow(session)
        break
      }
      case 'resumeAnalysis': {
        const run = s.db.analysisRuns.find((r) => r.id === str(args[0]) && r.createdBy === me)
        if (!run) throw new NexusError('NOT_FOUND', '分析不存在或无权操作')
        await runAgentsFor(session, run.transactionId, { resumeId: run.id })
        break
      }
      case 'confirmProfileUpdate': s.confirmProfileUpdate(me, str(args[0])); break
      case 'updateCompanyProfile': s.updateCompanyProfile(me, obj(args[0])); break
      case 'saveCashAccount': s.saveCashAccount(me, obj(args[0])); break
      case 'saveCostItem': {
        const cost = s.saveCostItem(me, obj(args[0]))
        try { await runAgentsFor(session, cost.transactionId, { event: { id: `ev_${crypto.randomUUID()}`, type: 'cost_committed', transactionId: cost.transactionId, contractId: null, at: new Date().toISOString(), summary: `项目成本已更新：${cost.name}`, payload: { amount: cost.amount, status: cost.status }, visibility: 'internal' } }) }
        catch { notice = '成本已保存，协同分析未完成，可在执行中心重试。' }
        break
      }
      case 'configureAi': {
        if (!session.aiSettings) throw new NexusError('CONFLICT', '当前运行环境不能保存连接设置')
        const config = session.aiSettings.save(args[0])
        pauseAnalyses(session)
        session.chatRun?.controller.abort()
        setRuntime(createDeepSeekRuntime(config))
        setLlmClient(createDeepSeekLlm(config))
        break
      }
      case 'disconnectAi':
        pauseAnalyses(session)
        session.chatRun?.controller.abort()
        session.aiSettings?.clear()
        setRuntime(null)
        setLlmClient(null)
        break
      case 'cancelChat':
        if (session.chatRun?.userId === me) session.chatRun.controller.abort()
        break
      case 'retryChat': {
        if (session.chatRun) throw new NexusError('CONFLICT', '请等待当前回答或停止生成')
        const id = str(args[0])
        const view = sessionView(session)
        if (!view.conversations.some((c) => c.id === id)) throw new NexusError('NOT_FOUND', '会话不存在')
        const last = view.chatMessages.filter((m) => m.conversationId === id && m.role === 'user').at(-1)
        if (!last) throw new NexusError('NOT_FOUND', '没有可重试的消息')
        await replyFor(session, id, last.body)
        break
      }
      case 'switchUser': {
        const id = str(args[0])
        if (!s.db.users.some((u) => u.id === id)) throw new NexusError('NOT_FOUND', '账号不存在')
        session.chatRun?.controller.abort()
        session.chatRun = undefined
        pauseAnalyses(session)
        session.generation++
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
        session.chatRun?.controller.abort()
        session.chatRun = undefined
        pauseAnalyses(session)
        session.generation++
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
        try { await runAgentsFor(session, contract.transactionId) }
        catch { notice = '付款安排已保存；协同分析未完成，请稍后重新运行分析。' }
        break
      }
      case 'runAgents': {
        // Manual re-run: the same graph, on demand, rather than only on a detected change.
        const id = str(args[0])
        await runAgentsFor(session, id, { event: { id: `ev_${crypto.randomUUID()}`, type: 'business_review_requested', transactionId: id, contractId: null, at: new Date().toISOString(), summary: '用户请求重新评估业务', payload: {}, visibility: 'internal' } })
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
      case 'updateMilestone': {
        const milestone = s.updateMilestone(me, str(args[0]), obj(args[1]))
        if (milestone.status === 'delayed') {
          try { await runAgentsFor(session, milestone.transactionId, { event: { id: `ev_${crypto.randomUUID()}`, type: 'milestone_delayed', transactionId: milestone.transactionId, contractId: null, at: new Date().toISOString(), summary: `履约节点延期：${milestone.name}`, payload: { dueDate: milestone.dueDate }, visibility: 'internal' } }) }
          catch { notice = '节点已保存，协同分析未完成，可稍后重试。' }
        }
        break
      }
      case 'startConversation': {
        if (session.chatRun) throw new NexusError('CONFLICT', '请等待当前回答或停止生成')
        const started = s.startConversation(me, str(args[0]))
        await replyFor(session, started.conversation.id, started.message.body)
        break
      }
      case 'sendChatMessage': {
        if (session.chatRun) throw new NexusError('CONFLICT', '请等待当前回答或停止生成')
        const sent = s.addChatMessage(me, str(args[0]), str(args[1]))
        await replyFor(session, sent.conversationId, sent.body)
        break
      }
      case 'renameConversation':
        s.renameConversation(me, str(args[0]), str(args[1]))
        break
    }
    return {
      ok: true,
      notice,
      state: buildViewState(s.db, session.currentUserId, {
        representingOrgId: session.actor.representingOrgId,
        // Local demo only: hand the renderer every account so it can switch between them.
        demoDirectory: true,
        runtime: { id: runtime.id, connected: runtime.connected }
      })
    }
  } catch (err) {
    if (err instanceof NexusError) return { ok: false, code: err.code, message: err.message }
    console.error('[handlers] unexpected error', err)
    return { ok: false, code: 'INTERNAL', message: '操作失败，请重试' }
  }
}
