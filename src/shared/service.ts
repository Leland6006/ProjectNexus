// Business engine. Every mutation takes an actorId and enforces the permission model.
// It operates on an in-memory Database and reports changes through onChange, so the
// Electron main process can persist to disk and tests can run without any I/O.

import { canViewContract, canViewTransaction, effectiveOrgId, isOwnerMember, isPartyMember } from './permissions.ts'
import { sanitizeHtml } from './sanitize.ts'
import { TEMPLATES } from './templates.ts'
import {
  NexusError,
  type Activity,
  type ActivityType,
  type Clause,
  type Comment,
  type Contract,
  type ContractVersion,
  type Database,
  type Message,
  type Milestone,
  type MilestoneStatus,
  type PaymentTerms,
  type Suggestion,
  type Transaction,
  type TransactionStatus,
  type User,
  type Visibility
} from './types.ts'

export interface Clock {
  now(): string
}

const systemClock: Clock = { now: () => new Date().toISOString() }

export interface CreateTransactionInput {
  name: string
  type: string
  counterpartyOrgId: string
  amount: number
  expectedSignDate: string
  description: string
  status?: TransactionStatus
}

export interface CreateMilestoneInput {
  transactionId: string
  name: string
  responsibleOrgId: string
  dueDate: string
  note?: string
  paymentAmount?: number
}

function uid(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new NexusError('INVALID_INPUT', `${field}不能为空`)
  }
  if (value.length > max) throw new NexusError('INVALID_INPUT', `${field}不能超过${max}个字符`)
  return value.trim()
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new NexusError('INVALID_INPUT', `${field}格式应为 YYYY-MM-DD`)
  }
  return value
}

export { sanitizeHtml }

function sanitizeClauses(clauses: Clause[]): Clause[] {
  if (!Array.isArray(clauses) || clauses.length === 0) {
    throw new NexusError('INVALID_INPUT', '合同至少需要一个条款')
  }
  if (clauses.length > 200) throw new NexusError('INVALID_INPUT', '条款数量过多')
  return clauses.map((c) => ({
    id: requireText(c.id, '条款编号', 64),
    title: requireText(c.title, '条款标题', 120),
    body: sanitizeHtml(String(c.body ?? '')).slice(0, 100_000)
  }))
}

function clauseToken(clauses: Clause[]): string {
  if (!Array.isArray(clauses) || clauses.length === 0 || clauses.length > 200 || clauses.some((clause) =>
    !clause || typeof clause.id !== 'string' || typeof clause.title !== 'string' || typeof clause.body !== 'string' ||
    clause.id.length > 64 || clause.title.length > 120 || clause.body.length > 100_000
  )) throw new NexusError('INVALID_INPUT', '条款基础快照无效，请重新载入合同')
  return JSON.stringify(clauses.map(({ id, title, body }) => [id, title, body]))
}

/**
 * Mutable actor state shared with the session. An external counsel may be granted
 * access by both parties; this records which one they are currently acting for so every
 * permission check resolves the same way.
 */
export interface ActorContext {
  representingOrgId: string | null
}

export class NexusService {
  readonly db: Database
  private readonly onChange: () => void
  private readonly clock: Clock
  private readonly actor: ActorContext

  constructor(db: Database, onChange: () => void = () => {}, clock: Clock = systemClock, actor: ActorContext = { representingOrgId: null }) {
    this.db = db
    this.onChange = onChange
    this.clock = clock
    this.actor = actor
  }

  // ---------- lookup helpers ----------

  private user(id: string): User {
    const u = this.db.users.find((x) => x.id === id)
    if (!u) throw new NexusError('NOT_FOUND', '账号不存在')
    return u
  }

  /** Transactions the actor cannot see are reported as missing, never as forbidden. */
  private tx(actor: User, id: string): { tx: Transaction; orgId: string } {
    const tx = this.db.transactions.find((t) => t.id === id)
    if (!tx || !canViewTransaction(actor, tx, this.actor.representingOrgId)) {
      throw new NexusError('NOT_FOUND', '交易项目不存在或无权访问')
    }
    return { tx, orgId: effectiveOrgId(actor, tx, this.actor.representingOrgId)! }
  }

  private contract(actor: User, id: string): { contract: Contract; tx: Transaction; orgId: string } {
    const contract = this.db.contracts.find((c) => c.id === id)
    if (!contract) throw new NexusError('NOT_FOUND', '合同不存在或无权访问')
    const found = this.tx(actor, contract.transactionId)
    if (!canViewContract(actor, found.tx, contract, this.actor.representingOrgId)) {
      throw new NexusError('NOT_FOUND', '合同不存在或无权访问')
    }
    return { contract, tx: found.tx, orgId: found.orgId }
  }

  private orgName(id: string): string {
    return this.db.organizations.find((o) => o.id === id)?.name ?? id
  }

  private log(
    actor: User,
    orgId: string,
    transactionId: string,
    contractId: string | null,
    type: ActivityType,
    summary: string,
    visibility: Visibility
  ): void {
    const a: Activity = {
      id: uid('act'),
      transactionId,
      contractId,
      actorId: actor.id,
      orgId,
      type,
      summary,
      visibility,
      createdAt: this.clock.now()
    }
    this.db.activities.push(a)
  }

  private commit(): void {
    this.onChange()
  }

  /** Ask the host to persist state that changed outside a service mutation (e.g. active account). */
  notifyChanged(): void {
    this.onChange()
  }

  private contractVisibility(c: Contract): Visibility {
    return c.sharedWithCounterparty ? 'shared' : 'internal'
  }

  private requireOwner(actor: User, tx: Transaction): void {
    if (!isOwnerMember(actor, tx)) throw new NexusError('PERMISSION_DENIED', '只有交易发起方成员可以执行此操作')
  }

  private requireParty(actor: User, tx: Transaction): void {
    if (!isPartyMember(actor, tx)) throw new NexusError('PERMISSION_DENIED', '外部律师无权执行此操作')
  }

  private requireEditable(contract: Contract): void {
    if (contract.status === 'finalized') throw new NexusError('CONFLICT', '合同已确认最终版本，不能再修改')
  }

  // ---------- transactions ----------

  createTransaction(actorId: string, input: CreateTransactionInput): Transaction {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能创建交易项目')
    const counterparty = this.db.organizations.find((o) => o.id === input.counterpartyOrgId)
    if (!counterparty || counterparty.kind !== 'company') throw new NexusError('INVALID_INPUT', '请选择有效的交易对方')
    if (counterparty.id === actor.orgId) throw new NexusError('INVALID_INPUT', '交易对方不能是本企业')
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new NexusError('INVALID_INPUT', '交易金额无效')
    const now = this.clock.now()
    const tx: Transaction = {
      id: uid('tx'),
      name: requireText(input.name, '交易名称', 80),
      type: requireText(input.type, '交易类型', 40),
      initiatorOrgId: actor.orgId,
      counterpartyOrgId: counterparty.id,
      amount,
      currency: 'CNY',
      expectedSignDate: requireDate(input.expectedSignDate, '预计签约时间'),
      description: String(input.description ?? '').slice(0, 2000),
      status: input.status ?? 'draft',
      counterpartyStatus: 'none',
      counselGrants: [],
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now
    }
    this.db.transactions.push(tx)
    this.log(actor, actor.orgId, tx.id, null, 'transaction_created', `${actor.name} 创建了交易项目「${tx.name}」`, 'internal')
    this.commit()
    return tx
  }

  updateTransaction(
    actorId: string,
    id: string,
    patch: Partial<Pick<Transaction, 'name' | 'type' | 'amount' | 'expectedSignDate' | 'description' | 'status'>>
  ): Transaction {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, id)
    this.requireOwner(actor, tx)
    if (patch.name !== undefined) tx.name = requireText(patch.name, '交易名称', 80)
    if (patch.type !== undefined) tx.type = requireText(patch.type, '交易类型', 40)
    if (patch.amount !== undefined) {
      const a = Number(patch.amount)
      if (!Number.isFinite(a) || a < 0 || a > 1e12) throw new NexusError('INVALID_INPUT', '交易金额无效')
      tx.amount = a
    }
    if (patch.expectedSignDate !== undefined) tx.expectedSignDate = requireDate(patch.expectedSignDate, '预计签约时间')
    if (patch.description !== undefined) tx.description = String(patch.description).slice(0, 2000)
    if (patch.status !== undefined) {
      const allowed: TransactionStatus[] = ['draft', 'negotiating', 'pending_signature', 'in_performance', 'completed', 'cancelled']
      if (!allowed.includes(patch.status)) throw new NexusError('INVALID_INPUT', '交易状态无效')
      tx.status = patch.status
    }
    tx.updatedAt = this.clock.now()
    this.log(actor, actor.orgId, tx.id, null, 'transaction_updated', `${actor.name} 更新了交易项目「${tx.name}」`, 'shared')
    this.commit()
    return tx
  }

  /** Invite the transaction's counterparty into the shared workspace. */
  inviteCounterparty(actorId: string, transactionId: string): Transaction {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, transactionId)
    this.requireOwner(actor, tx)
    if (tx.counterpartyStatus !== 'none') throw new NexusError('CONFLICT', '已向交易对方发出邀请')
    tx.counterpartyStatus = 'invited'
    tx.updatedAt = this.clock.now()
    if (tx.status === 'draft') tx.status = 'negotiating'
    this.log(actor, actor.orgId, tx.id, null, 'counterparty_invited', `${actor.name} 邀请 ${this.orgName(tx.counterpartyOrgId)} 加入交易项目`, 'shared')
    this.commit()
    return tx
  }

  acceptInvitation(actorId: string, transactionId: string): Transaction {
    const actor = this.user(actorId)
    const { tx, orgId } = this.tx(actor, transactionId)
    if (orgId !== tx.counterpartyOrgId || actor.role === 'external_counsel') {
      throw new NexusError('PERMISSION_DENIED', '只有被邀请的交易对方可以接受邀请')
    }
    if (tx.counterpartyStatus === 'joined') return tx
    tx.counterpartyStatus = 'joined'
    tx.updatedAt = this.clock.now()
    this.log(actor, orgId, tx.id, null, 'counterparty_joined', `${actor.name} 代表 ${this.orgName(orgId)} 加入了交易项目`, 'shared')
    this.commit()
    return tx
  }

  /** A party grants one of the external counsel accounts access to this transaction. */
  grantCounsel(actorId: string, transactionId: string, counselUserId: string): Transaction {
    const actor = this.user(actorId)
    const { tx, orgId } = this.tx(actor, transactionId)
    this.requireParty(actor, tx)
    const counsel = this.db.users.find((u) => u.id === counselUserId && u.role === 'external_counsel')
    if (!counsel) throw new NexusError('NOT_FOUND', '律师账号不存在')
    if (tx.counselGrants.some((g) => g.userId === counsel.id)) throw new NexusError('CONFLICT', '该律师已获得授权')
    tx.counselGrants.push({
      userId: counsel.id,
      grantedByOrgId: orgId,
      grantedByUserId: actor.id,
      grantedAt: this.clock.now()
    })
    tx.updatedAt = this.clock.now()
    this.log(actor, orgId, tx.id, null, 'counsel_invited', `${actor.name} 邀请外部律师 ${counsel.name} 参与本交易`, 'counsel')
    this.commit()
    return tx
  }

  // ---------- contracts ----------

  createContract(actorId: string, transactionId: string, title: string, templateId?: string): Contract {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, transactionId)
    this.requireOwner(actor, tx)
    const template = templateId ? TEMPLATES.find((t) => t.id === templateId) : undefined
    if (templateId && !template) throw new NexusError('NOT_FOUND', '合同模板不存在')
    const clauses: Clause[] = (template?.clauses ?? [{ title: '第一条 总则', body: '<p>请在此处输入条款内容。</p>' }]).map(
      (c) => ({ id: uid('cl'), title: c.title, body: c.body })
    )
    const now = this.clock.now()
    const contract: Contract = {
      id: uid('ct'),
      transactionId,
      title: requireText(title, '合同名称', 100),
      status: 'draft',
      clauses,
      paymentTerms: null,
      sharedWithCounterparty: false,
      sharedAt: null,
      finalVersionId: null,
      finalConfirmedBy: [],
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now
    }
    this.db.contracts.push(contract)
    this.snapshot(actor, contract, '初稿', template ? `基于模板「${template.name}」创建` : '空白合同', false)
    this.log(actor, actor.orgId, transactionId, contract.id, 'contract_created', `${actor.name} 创建了合同「${contract.title}」`, 'internal')
    this.commit()
    return contract
  }

  shareContract(actorId: string, contractId: string): Contract {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    if (tx.counterpartyStatus === 'none') throw new NexusError('CONFLICT', '请先邀请交易对方')
    if (contract.sharedWithCounterparty) return contract
    contract.sharedWithCounterparty = true
    contract.sharedAt = this.clock.now()
    contract.updatedAt = contract.sharedAt
    if (contract.status === 'draft') contract.status = 'negotiating'
    this.log(actor, actor.orgId, tx.id, contract.id, 'contract_shared', `${actor.name} 将合同「${contract.title}」共享给 ${this.orgName(tx.counterpartyOrgId)}`, 'shared')
    this.commit()
    return contract
  }

  /** Replace the clause set of the working draft (owner organisation only). */
  updateClauses(actorId: string, contractId: string, clauses: Clause[], baseClauses?: Clause[]): Contract {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    if (baseClauses !== undefined && clauseToken(baseClauses) !== clauseToken(contract.clauses)) {
      throw new NexusError('CONFLICT', '远端合同条款已修改，本地草稿尚未保存。请先复制本地内容，再重新载入最新条款后编辑。')
    }
    contract.clauses = sanitizeClauses(clauses)
    contract.updatedAt = this.clock.now()
    this.commit()
    return contract
  }

  /**
   * Change the structured payment terms. This is what makes a commercial change
   * machine-readable: the new version carries a terms snapshot, so the context engine
   * can diff numbers instead of parsing prose.
   */
  updatePaymentTerms(actorId: string, contractId: string, terms: PaymentTerms | null): Contract {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    if (terms) {
      if (!Number.isFinite(terms.prepayRate) || terms.prepayRate < 0 || terms.prepayRate > 1) {
        throw new NexusError('INVALID_INPUT', '预付款比例需在 0 到 1 之间')
      }
      if (!Number.isInteger(terms.settlementDays) || terms.settlementDays < 0 || terms.settlementDays > 365) {
        throw new NexusError('INVALID_INPUT', '账期天数需在 0 到 365 之间')
      }
      let total = terms.prepayRate
      for (const i of terms.instalments) {
        if (!Number.isFinite(i.rate) || i.rate < 0) throw new NexusError('INVALID_INPUT', '分期比例不能为负')
        total += i.rate
      }
      if (total > 1.000001) throw new NexusError('INVALID_INPUT', '预付款与分期比例合计不能超过 100%')
      contract.paymentTerms = structuredClone(terms)
    } else {
      contract.paymentTerms = null
    }
    contract.updatedAt = this.clock.now()
    this.snapshot(actor, contract, '付款条款变更', '更新结构化付款条款', true)
    this.commit()
    return contract
  }

  private snapshot(actor: User, contract: Contract, label: string, note: string, log: boolean): ContractVersion {
    const number = this.db.versions.filter((v) => v.contractId === contract.id).length + 1
    const v: ContractVersion = {
      id: uid('ver'),
      contractId: contract.id,
      number,
      label,
      note,
      clauses: contract.clauses.map((c) => ({ ...c })),
      paymentTerms: contract.paymentTerms ? structuredClone(contract.paymentTerms) : null,
      authorId: actor.id,
      createdAt: this.clock.now()
    }
    this.db.versions.push(v)
    if (log) {
      this.log(actor, actor.orgId, contract.transactionId, contract.id, 'version_saved', `${actor.name} 保存了版本 v${number}「${label}」`, this.contractVisibility(contract))
    }
    return v
  }

  saveVersion(actorId: string, contractId: string, label: string, note = ''): ContractVersion {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    const v = this.snapshot(actor, contract, requireText(label, '版本名称', 60), String(note).slice(0, 500), true)
    // A new version invalidates earlier final-version confirmations.
    contract.finalConfirmedBy = []
    contract.updatedAt = v.createdAt
    this.commit()
    return v
  }

  restoreVersion(actorId: string, contractId: string, versionId: string): Contract {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    const v = this.db.versions.find((x) => x.id === versionId && x.contractId === contractId)
    if (!v) throw new NexusError('NOT_FOUND', '版本不存在')
    contract.clauses = v.clauses.map((c) => ({ ...c }))
    contract.finalConfirmedBy = []
    contract.updatedAt = this.clock.now()
    const restored = this.snapshot(actor, contract, `恢复自 v${v.number}`, `从历史版本 v${v.number} 恢复`, false)
    this.log(actor, actor.orgId, tx.id, contract.id, 'version_restored', `${actor.name} 将合同恢复为 v${v.number}，生成新版本 v${restored.number}`, this.contractVisibility(contract))
    this.commit()
    return contract
  }

  confirmFinal(actorId: string, contractId: string, versionId: string): Contract {
    const actor = this.user(actorId)
    const { contract, tx, orgId } = this.contract(actor, contractId)
    this.requireParty(actor, tx)
    this.requireEditable(contract)
    if (!contract.sharedWithCounterparty) throw new NexusError('CONFLICT', '合同尚未共享给交易对方')
    const latest = this.db.versions.filter((v) => v.contractId === contractId).sort((a, b) => b.number - a.number)[0]
    if (!latest || latest.id !== versionId) throw new NexusError('CONFLICT', '只能确认最新版本')
    if (contract.finalVersionId !== versionId) {
      contract.finalVersionId = versionId
      contract.finalConfirmedBy = []
    }
    if (!contract.finalConfirmedBy.includes(orgId)) contract.finalConfirmedBy.push(orgId)
    contract.updatedAt = this.clock.now()
    const both = [tx.initiatorOrgId, tx.counterpartyOrgId].every((o) => contract.finalConfirmedBy.includes(o))
    if (both) {
      contract.status = 'finalized'
      if (tx.status === 'negotiating' || tx.status === 'draft') tx.status = 'pending_signature'
      tx.updatedAt = contract.updatedAt
    }
    this.log(
      actor,
      orgId,
      tx.id,
      contract.id,
      'final_confirmed',
      both ? `双方已确认合同最终版本 v${latest.number}` : `${actor.name} 代表 ${this.orgName(orgId)} 确认了版本 v${latest.number}，等待对方确认`,
      'shared'
    )
    this.commit()
    return contract
  }

  // ---------- comments ----------

  addComment(
    actorId: string,
    contractId: string,
    clauseId: string,
    body: string,
    visibility: Visibility,
    parentId: string | null = null
  ): Comment {
    const actor = this.user(actorId)
    const { contract, tx, orgId } = this.contract(actor, contractId)
    if (!contract.clauses.some((c) => c.id === clauseId)) throw new NexusError('NOT_FOUND', '条款不存在')
    // Counsel may only write to their granting organisation (never to the other side).
    const allowed: Visibility[] = actor.role === 'external_counsel' ? ['counsel'] : ['shared', 'internal', 'counsel']
    if (!allowed.includes(visibility)) throw new NexusError('PERMISSION_DENIED', '无权使用该可见范围')
    if (visibility === 'shared' && !contract.sharedWithCounterparty) {
      throw new NexusError('CONFLICT', '合同尚未共享，不能发表共享评论')
    }
    let parent: Comment | undefined
    if (parentId) {
      parent = this.db.comments.find((c) => c.id === parentId && c.contractId === contractId)
      if (!parent) throw new NexusError('NOT_FOUND', '被回复的评论不存在')
      // Replying requires being able to see the parent comment.
      const parentVisible =
        parent.visibility === 'shared' ||
        (parent.visibility === 'internal' && actor.role !== 'external_counsel' && orgId === parent.orgId) ||
        (parent.visibility === 'counsel' && orgId === parent.orgId)
      if (!parentVisible) throw new NexusError('NOT_FOUND', '被回复的评论不存在')
      // A reply cannot be wider than its parent's audience (no leaking internal threads).
      if (parent.visibility !== 'shared' && visibility === 'shared') {
        throw new NexusError('PERMISSION_DENIED', '不能在内部讨论中使用共享可见范围回复')
      }
    }
    const comment: Comment = {
      id: uid('cm'),
      contractId,
      clauseId,
      parentId,
      authorId: actor.id,
      orgId,
      body: requireText(body, '评论内容', 2000),
      visibility,
      createdAt: this.clock.now()
    }
    this.db.comments.push(comment)
    const clause = contract.clauses.find((c) => c.id === clauseId)!
    this.log(
      actor,
      orgId,
      tx.id,
      contract.id,
      parent ? 'comment_replied' : 'comment_added',
      `${actor.name} ${parent ? '回复了' : '评论了'}「${clause.title}」`,
      visibility
    )
    this.commit()
    return comment
  }

  // ---------- suggestions ----------

  createSuggestion(actorId: string, contractId: string, clauseId: string, proposedBody: string, reason: string): Suggestion {
    const actor = this.user(actorId)
    const { contract, tx, orgId } = this.contract(actor, contractId)
    this.requireParty(actor, tx)
    this.requireEditable(contract)
    if (!contract.sharedWithCounterparty) throw new NexusError('CONFLICT', '合同尚未共享')
    const clause = contract.clauses.find((c) => c.id === clauseId)
    if (!clause) throw new NexusError('NOT_FOUND', '条款不存在')
    const proposed = sanitizeHtml(String(proposedBody ?? '')).slice(0, 100_000)
    if (proposed.trim() === clause.body.trim()) throw new NexusError('INVALID_INPUT', '修改建议与现有内容相同')
    const s: Suggestion = {
      id: uid('sg'),
      contractId,
      clauseId,
      authorId: actor.id,
      orgId,
      originalBody: clause.body,
      proposedBody: proposed,
      reason: requireText(reason, '修改理由', 1000),
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: this.clock.now()
    }
    this.db.suggestions.push(s)
    this.log(actor, orgId, tx.id, contract.id, 'suggestion_created', `${actor.name} 对「${clause.title}」提出了修改建议`, 'shared')
    this.commit()
    return s
  }

  resolveSuggestion(actorId: string, suggestionId: string, accept: boolean): Suggestion {
    const actor = this.user(actorId)
    const s = this.db.suggestions.find((x) => x.id === suggestionId)
    if (!s) throw new NexusError('NOT_FOUND', '修改建议不存在')
    const { contract, tx, orgId } = this.contract(actor, s.contractId)
    this.requireParty(actor, tx)
    this.requireEditable(contract)
    if (s.status !== 'pending') throw new NexusError('CONFLICT', '该建议已处理')
    if (orgId === s.orgId) throw new NexusError('PERMISSION_DENIED', '修改建议需由对方处理')
    const clause = contract.clauses.find((c) => c.id === s.clauseId)
    if (!clause) throw new NexusError('NOT_FOUND', '条款已不存在')
    if (accept) {
      if (clause.body !== s.originalBody) {
        throw new NexusError('CONFLICT', '条款内容在建议提出后已被修改，请对方基于最新内容重新提出')
      }
      clause.body = s.proposedBody
      contract.updatedAt = this.clock.now()
      contract.finalConfirmedBy = []
    }
    s.status = accept ? 'accepted' : 'rejected'
    s.resolvedBy = actor.id
    s.resolvedAt = this.clock.now()
    this.log(
      actor,
      orgId,
      tx.id,
      contract.id,
      accept ? 'suggestion_accepted' : 'suggestion_rejected',
      `${actor.name} ${accept ? '接受了' : '拒绝了'}对「${clause.title}」的修改建议`,
      'shared'
    )
    this.commit()
    return s
  }

  // ---------- messages ----------

  sendMessage(actorId: string, transactionId: string, body: string, visibility: 'shared' | 'internal'): Message {
    const actor = this.user(actorId)
    const { tx, orgId } = this.tx(actor, transactionId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师请通过合同评论反馈意见')
    if (visibility === 'shared' && tx.counterpartyStatus === 'none') {
      throw new NexusError('CONFLICT', '请先邀请交易对方，再发送共享消息')
    }
    const m: Message = {
      id: uid('msg'),
      transactionId,
      authorId: actor.id,
      orgId,
      body: requireText(body, '消息内容', 2000),
      visibility,
      createdAt: this.clock.now()
    }
    this.db.messages.push(m)
    this.commit()
    return m
  }

  // ---------- milestones ----------

  createMilestone(actorId: string, input: CreateMilestoneInput): Milestone {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, input.transactionId)
    this.requireParty(actor, tx)
    if (![tx.initiatorOrgId, tx.counterpartyOrgId].includes(input.responsibleOrgId)) {
      throw new NexusError('INVALID_INPUT', '责任方必须是交易双方之一')
    }
    const pay = Number(input.paymentAmount ?? 0)
    if (!Number.isFinite(pay) || pay < 0) throw new NexusError('INVALID_INPUT', '付款金额无效')
    const m: Milestone = {
      id: uid('ms'),
      transactionId: tx.id,
      name: requireText(input.name, '节点名称', 80),
      responsibleOrgId: input.responsibleOrgId,
      dueDate: requireDate(input.dueDate, '计划日期'),
      status: 'pending',
      note: String(input.note ?? '').slice(0, 1000),
      paymentAmount: pay,
      createdBy: actor.id,
      createdAt: this.clock.now()
    }
    this.db.milestones.push(m)
    this.log(actor, effectiveOrgId(actor, tx, this.actor.representingOrgId)!, tx.id, null, 'milestone_created', `${actor.name} 创建了履约节点「${m.name}」`, 'shared')
    this.commit()
    return m
  }

  updateMilestone(actorId: string, milestoneId: string, patch: { status?: MilestoneStatus; note?: string }): Milestone {
    const actor = this.user(actorId)
    const m = this.db.milestones.find((x) => x.id === milestoneId)
    if (!m) throw new NexusError('NOT_FOUND', '履约节点不存在')
    const { tx, orgId } = this.tx(actor, m.transactionId)
    this.requireParty(actor, tx)
    if (patch.status !== undefined) {
      if (!['pending', 'in_progress', 'completed', 'delayed'].includes(patch.status)) {
        throw new NexusError('INVALID_INPUT', '节点状态无效')
      }
      m.status = patch.status
    }
    if (patch.note !== undefined) m.note = String(patch.note).slice(0, 1000)
    this.log(actor, orgId, tx.id, null, 'milestone_updated', `${actor.name} 更新了履约节点「${m.name}」`, 'shared')
    this.commit()
    return m
  }
}
