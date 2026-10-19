import * as ledger from './ledger.ts'
import * as workflows from './workflows.ts'
import { clausesFingerprint, reviewFingerprint, internalReviewBlocker } from './terms.ts'
// Business engine. Every mutation takes an actorId and enforces the permission model.
// It operates on an in-memory Database and reports changes through onChange, so the
// Electron main process can persist to disk and tests can run without any I/O.

import { canViewContract, canViewTransaction, effectiveOrgId, isOwnerMember, isPartyMember } from './permissions.ts'
import { sanitizeHtml } from './sanitize.ts'
import { TEMPLATES } from './templates.ts'
import { CHAT_MESSAGE_MAX, CHAT_TITLE_MAX, conversationTitle, type RuntimeReply } from './chat.ts'
import {
  NexusError,
  type CompanyProfile,
  type ContractImportDraft,
  type CashAccount,
  type CostItem,
  type Activity,
  type ActivityType,
  type ChatMessage,
  type ChatRole,
  type Conversation,
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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
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

  /** Independent contacts are owned by one enterprise, with no platform identity. */
  createCounterparty(actorId: string, input: { name: string; contactName?: string; email?: string }) {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能管理交易对象')
    const name = requireText(input.name, '企业名称', 120)
    if (name === this.orgName(actor.orgId)) throw new NexusError('INVALID_INPUT', '交易对象不能是本企业')
    const email = String(input.email ?? '').trim()
    if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new NexusError('INVALID_INPUT', '邮箱格式无效')
    const old = this.db.counterparties.find((c) => c.orgId === actor.orgId && c.name.toLowerCase() === name.toLowerCase())
    if (old) return old
    const cp = { id: uid('cp'), orgId: actor.orgId, name, contactName: String(input.contactName ?? '').trim().slice(0, 80), email, createdAt: this.clock.now() }
    this.db.counterparties.push(cp)
    this.db.organizations.push({ id: cp.id, name, shortName: name.slice(0, 16), kind: 'company', localOnly: true, ownerOrgId: actor.orgId })
    this.commit()
    return cp
  }

  stageContractImport(actorId: string, input: Pick<ContractImportDraft, 'fileName' | 'rawText' | 'candidates' | 'warnings'>) {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能导入合同')
    const rawText = requireText(input.rawText, '合同正文', 100_000)
    const draft: ContractImportDraft = { ...input, rawText, fileName: requireText(input.fileName, '文件名', 255), id: uid('imp'), orgId: actor.orgId, createdBy: actorId, status: 'pending', contractId: null, createdAt: this.clock.now() }
    this.db.importDrafts.push(draft)
    this.commit()
    return draft
  }

  /** Stage all mutations in a copy: invalid confirmation cannot leave an orphan project. */
  confirmContractImport(actorId: string, id: string, input: {
    title: string; transactionId?: string; counterpartyName?: string; name?: string; amount?: number;
    expectedSignDate?: string; acknowledged: boolean
  }) {
    const actor = this.user(actorId)
    const draft = this.db.importDrafts.find((d) => d.id === id && d.createdBy === actorId && d.orgId === actor.orgId)
    if (!draft || actor.role === 'external_counsel') throw new NexusError('NOT_FOUND', '导入草稿不存在或无权访问')
    if (draft.status === 'confirmed') return this.db.contracts.find((c) => c.id === draft.contractId)!
    if (input.acknowledged !== true) throw new NexusError('INVALID_INPUT', '请先核对正文与业务信息，并确认导入限制')
    const staged = structuredClone(this.db)
    const service = new NexusService(staged, () => {}, this.clock, this.actor)
    let transactionId = input.transactionId
    if (!transactionId) {
      const cp = service.createCounterparty(actorId, { name: input.counterpartyName ?? '' })
      transactionId = service.createTransaction(actorId, { name: input.name ?? '', type: '其他', counterpartyOrgId: cp.id, amount: input.amount ?? NaN, expectedSignDate: input.expectedSignDate ?? '', description: `根据本地文件「${draft.fileName}」人工确认后建立` }).id
    }
    const contract = service.createContract(actorId, transactionId, input.title)
    // Group paragraphs into <=200 clauses; HTML characters are always escaped.
    const lines = draft.rawText.split(/\n+/).filter((x) => x.trim())
    const size = Math.max(1, Math.ceil(lines.length / 200))
    const escaped = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const clauses: Clause[] = []
    for (let i = 0; i < lines.length; i += size) clauses.push({ id: uid('cl'), title: `导入正文 ${clauses.length + 1}`, body: lines.slice(i, i + size).map((l) => `<p>${escaped(l)}</p>`).join('') })
    service.updateClauses(actorId, contract.id, clauses)
    service.saveVersion(actorId, contract.id, '导入核对稿', `文字来自 ${draft.fileName}，经用户确认；原文件排版、附件与签章不在本版本中`)
    const d = staged.importDrafts.find((d) => d.id === id)!
    d.status = 'confirmed'; d.contractId = contract.id
    Object.assign(this.db, staged)
    this.commit()
    return contract
  }

  private reviewFingerprint(contract: Contract): string {
    return reviewFingerprint(contract, this.db.versions)
  }

  requestInternalReview(actorId: string, contractId: string, reviewerId: string) {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    const reviewer = this.db.users.find((u) => u.id === reviewerId && u.orgId === actor.orgId && u.role !== 'external_counsel' && u.id !== actor.id)
    if (!reviewer) throw new NexusError('INVALID_INPUT', '请选择本企业的其他成员作为审阅人')
    const sourceFingerprint = this.reviewFingerprint(contract)
    const old = this.db.internalReviews.find((r) => r.contractId === contractId && r.orgId === actor.orgId && r.reviewerId === reviewerId && r.status === 'pending' && r.sourceFingerprint === sourceFingerprint)
    if (old) return old
    const review = { id: uid('rev'), orgId: actor.orgId, transactionId: tx.id, contractId, requestedBy: actorId, reviewerId, sourceFingerprint, status: 'pending' as const, comment: '', createdAt: this.clock.now(), decidedAt: null }
    this.db.internalReviews.push(review)
    this.commit()
    return review
  }

  decideInternalReview(actorId: string, id: string, input: { decision: 'approved' | 'rejected'; comment: string }) {
    const actor = this.user(actorId)
    const review = this.db.internalReviews.find((r) => r.id === id && r.orgId === actor.orgId && r.reviewerId === actorId)
    if (!review || actor.role === 'external_counsel') throw new NexusError('NOT_FOUND', '审阅不存在或无权处理')
    if (!['approved', 'rejected'].includes(input.decision)) throw new NexusError('INVALID_INPUT', '审阅决定无效')
    const { contract, tx } = this.contract(actor, review.contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    if (review.status !== 'pending') throw new NexusError('CONFLICT', '审阅已经处理')
    if (review.sourceFingerprint !== this.reviewFingerprint(contract)) throw new NexusError('CONFLICT', '合同已更新，请重新发起内部审阅')
    const comment = requireText(input.comment, '审阅意见', 2000)
    review.status = input.decision; review.comment = comment; review.decidedAt = this.clock.now()
    this.commit()
    return review
  }

  // ---------- transactions ----------

  createTransaction(actorId: string, input: CreateTransactionInput): Transaction {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能创建交易项目')
    const counterparty = this.db.organizations.find((o) => o.id === input.counterpartyOrgId)
    if (!counterparty || counterparty.kind !== 'company') throw new NexusError('INVALID_INPUT', '请选择有效的交易对方')
    if (counterparty.localOnly && counterparty.ownerOrgId !== actor.orgId) throw new NexusError('PERMISSION_DENIED', '无权使用该交易对象')
    if (counterparty.id === actor.orgId) throw new NexusError('INVALID_INPUT', '交易对方不能是本企业')
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new NexusError('INVALID_INPUT', '交易金额无效')
    const statuses: TransactionStatus[] = ['draft', 'negotiating', 'pending_signature', 'in_performance', 'completed', 'cancelled']
    if (input.status !== undefined && !statuses.includes(input.status)) throw new NexusError('INVALID_INPUT', '交易状态无效')
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
    this.invalidateFinancialProposals(tx.initiatorOrgId, tx.id)
    this.invalidateFinancialProposals(tx.counterpartyOrgId, tx.id)
    this.log(actor, actor.orgId, tx.id, null, 'transaction_updated', `${actor.name} 更新了交易项目「${tx.name}」`, 'shared')
    this.commit()
    return tx
  }

  /** Invite the transaction's counterparty into the shared workspace. */
  inviteCounterparty(actorId: string, transactionId: string): Transaction {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, transactionId)
    this.requireOwner(actor, tx)
    if (this.db.organizations.find((o) => o.id === tx.counterpartyOrgId)?.localOnly) throw new NexusError('CONFLICT', '这是本企业的本地交易对象。线上邀请尚未接通账号和同步服务')
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
  updateClauses(actorId: string, contractId: string, clauses: Clause[]): Contract {
    const actor = this.user(actorId)
    const { contract, tx } = this.contract(actor, contractId)
    this.requireOwner(actor, tx)
    this.requireEditable(contract)
    contract.clauses = sanitizeClauses(clauses)
    this.invalidateFinancialProposals(tx.initiatorOrgId, tx.id)
    this.invalidateFinancialProposals(tx.counterpartyOrgId, tx.id)
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
      if (!Array.isArray(terms.instalments) || terms.instalments.length > 24) throw new NexusError('INVALID_INPUT', '分期最多24笔')
      if (terms.payerOrgId && ![tx.initiatorOrgId, tx.counterpartyOrgId].includes(terms.payerOrgId)) throw new NexusError('INVALID_INPUT', '付款方必须是交易当事方')
      if (terms.acceptanceDate) {
        requireDate(terms.acceptanceDate, '预计验收日')
        if (terms.acceptanceDate < tx.expectedSignDate) throw new NexusError('INVALID_INPUT', '验收日不能早于预计签约日')
      }
      let total = terms.prepayRate
      for (const i of terms.instalments) {
        requireText(i.id, '分期编号', 64)
        requireText(i.label, '分期名称', 100)
        requireDate(i.dueDate, '分期日期')
        if (!Number.isFinite(i.rate) || i.rate < 0) throw new NexusError('INVALID_INPUT', '分期比例不能为负')
        total += i.rate
      }
      if (total > 1.000001) throw new NexusError('INVALID_INPUT', '预付款与分期比例合计不能超过 100%')
      contract.paymentTerms = { ...structuredClone(terms), verifiedClausesFingerprint: clausesFingerprint(contract.clauses) }
    } else {
      contract.paymentTerms = null
    }
    this.invalidateFinancialProposals(tx.initiatorOrgId, tx.id)
    this.invalidateFinancialProposals(tx.counterpartyOrgId, tx.id)
    contract.finalConfirmedBy = []
    contract.finalVersionId = null
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
    if (JSON.stringify(latest.clauses) !== JSON.stringify(contract.clauses) || JSON.stringify(latest.paymentTerms) !== JSON.stringify(contract.paymentTerms)) throw new NexusError('CONFLICT', '工作稿与最新版本不一致，请先保存为新版本')
    const reviewBlock = internalReviewBlocker(contract, this.db.versions, this.db.internalReviews, orgId)
    if (reviewBlock) throw new NexusError('CONFLICT', reviewBlock)
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

  // ---------- Company data (human-entered; no model writes) ----------

  updateCompanyProfile(actorId: string, input: Omit<CompanyProfile, 'updatedAt' | 'updatedBy'>): void {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能修改经营资料')
    const text = (value: unknown, name: string, max: number): string => {
      if (typeof value !== 'string' || value.length > max) throw new NexusError('INVALID_INPUT', `${name}格式或长度无效`)
      return value.trim()
    }
    if (input.teamSize !== null && (!Number.isInteger(input.teamSize) || input.teamSize < 1 || input.teamSize > 100000)) {
      throw new NexusError('INVALID_INPUT', '团队规模应为正整数或留空')
    }
    const profile: CompanyProfile = {
      industry: text(input.industry, '行业', 100), business: text(input.business, '主营业务', 2000),
      goal: text(input.goal, '经营目标', 2000), stage: text(input.stage, '阶段', 100),
      region: text(input.region, '地区', 100), teamSize: input.teamSize,
      updatedAt: this.clock.now(), updatedBy: actor.id
    }
    this.db.organizations.find((o) => o.id === actor.orgId)!.profile = profile
    this.invalidateFinancialProposals(actor.orgId)
    this.commit()
  }

  private invalidateFinancialProposals(orgId: string, transactionId?: string): void {
    // Pending analyses are drafts of old data. Keep their history, force fresh approval.
    for (const proposal of this.db.proposals) {
      if (proposal.orgId === orgId && proposal.status === 'pending' && (!transactionId || proposal.transactionId === transactionId)) {
        proposal.invalidatedReason = '基础资料已更新，请重新分析。'
      }
    }
    for (const task of this.db.tasks) {
      if (task.orgId === orgId && (!transactionId || task.transactionId === transactionId) && !['completed', 'cancelled'].includes(task.status) && !task.requiresReview) {
        task.requiresReview = true
        task.revision++
        task.updatedAt = this.clock.now()
        task.history.push({ at: task.updatedAt, actorId: 'system', summary: '基础数据已更新，继续前需核对最新信息' })
      }
    }
    for (const claim of this.db.claims) {
      if (claim.orgId === orgId && (!transactionId || claim.transactionId === transactionId) && (claim.source.kind === 'agent' || (!!transactionId && claim.key.startsWith('payment.'))) && !claim.supersededById) {
        claim.supersededById = 'source-data-updated'
      }
    }
  }

  saveCashAccount(actorId: string, input: { id?: string; label: string; openingBalance: number; asOf: string }): CashAccount {
    const actor = this.user(actorId)
    if (actor.role === 'external_counsel') throw new NexusError('PERMISSION_DENIED', '外部律师不能管理企业资金')
    const existing = input.id ? this.db.cashAccounts.find((a) => a.id === input.id && a.orgId === actor.orgId) : undefined
    if (input.id && !existing) throw new NexusError('NOT_FOUND', '账户不存在')
    const account: CashAccount = {
      id: existing?.id ?? uid('cash'), orgId: actor.orgId, label: requireText(input.label, '账户名称', 100),
      openingBalance: this.money(input.openingBalance), asOf: requireDate(input.asOf, '余额日期'),
      updatedAt: this.clock.now(), updatedBy: actor.id
    }
    if (existing) Object.assign(existing, account)
    else this.db.cashAccounts.push(account)
    this.invalidateFinancialProposals(actor.orgId)
    this.commit()
    return account
  }

  private money(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > 0.001) {
      throw new NexusError('INVALID_INPUT', '金额须为非负数，最多两位小数，且不超过一万亿元')
    }
    return Math.round(value * 100) / 100
  }

  saveCostItem(actorId: string, input: { id?: string; transactionId: string; name: string; amount: number; dueDate: string; status: CostItem['status'] }): CostItem {
    const actor = this.user(actorId)
    const { tx } = this.tx(actor, input.transactionId)
    this.requireParty(actor, tx)
    const existing = input.id ? this.db.costItems.find((c) => c.id === input.id && c.orgId === actor.orgId && c.transactionId === tx.id) : undefined
    if (input.id && !existing) throw new NexusError('NOT_FOUND', '成本不存在')
    if (existing && this.db.cashPlans.some((p) => p.costItemId === existing.id && p.status === 'active')) throw new NexusError('CONFLICT', '该成本已关联收付计划。请先取消计划再修改成本；已发生的实际收支仍保留')
    if (!['planned', 'committed', 'paid'].includes(input.status)) throw new NexusError('INVALID_INPUT', '成本状态无效')
    const cost: CostItem = {
      id: existing?.id ?? uid('cost'), orgId: actor.orgId, transactionId: tx.id,
      name: requireText(input.name, '成本名称', 100), amount: this.money(input.amount), dueDate: requireDate(input.dueDate, '支出日期'),
      status: input.status, visibility: 'internal', createdBy: existing?.createdBy ?? actor.id,
      createdAt: existing?.createdAt ?? this.clock.now(), updatedAt: this.clock.now()
    }
    if (existing) Object.assign(existing, cost)
    else this.db.costItems.push(cost)
    this.invalidateFinancialProposals(actor.orgId)
    this.commit()
    return cost
  }

  createTask(actorId: string, input: Parameters<typeof workflows.createTask>[2]) {
    const task = workflows.createTask(this.db, actorId, input, this.clock.now())
    this.commit()
    return task
  }

  updateTask(actorId: string, taskId: string, input: Parameters<typeof workflows.updateTask>[3]) {
    const task = workflows.updateTask(this.db, actorId, taskId, input, this.clock.now())
    this.commit()
    return task
  }

  completeTaskStep(actorId: string, taskId: string, input: Parameters<typeof workflows.completeTaskStep>[3]) {
    const task = workflows.completeTaskStep(this.db, actorId, taskId, input, this.clock.now())
    this.commit()
    return task
  }

  saveCashPlan(actorId: string, input: Parameters<typeof ledger.saveCashPlan>[2]) {
    const result = ledger.saveCashPlan(this.db, actorId, input, this.clock.now())
    this.invalidateFinancialProposals(this.user(actorId).orgId)
    this.commit()
    return result
  }

  cancelCashPlan(actorId: string, id: string, revision: number) {
    ledger.cancelCashPlan(this.db, actorId, id, revision, this.clock.now())
    this.invalidateFinancialProposals(this.user(actorId).orgId)
    this.commit()
  }
  recordCashEntry(actorId: string, input: Parameters<typeof ledger.recordCashEntry>[2]) {
    const before = this.db.cashEntries.length
    const result = ledger.recordCashEntry(this.db, actorId, input, this.clock.now())
    if (before !== this.db.cashEntries.length) { this.invalidateFinancialProposals(this.user(actorId).orgId); this.commit() }
    return result
  }

  voidCashEntry(actorId: string, id: string, reason: string) {
    const before = this.db.cashEntries.find((e) => e.id === id)?.status
    ledger.voidCashEntry(this.db, actorId, id, reason, this.clock.now())
    if (before === 'void') return
    this.invalidateFinancialProposals(this.user(actorId).orgId)
    this.commit()
  }
  saveInvoiceCase(actorId: string, input: Parameters<typeof ledger.saveInvoiceCase>[2]) {
    const result = ledger.saveInvoiceCase(this.db, actorId, input, this.clock.now())
    this.commit()
    return result
  }

  advanceInvoiceCase(actorId: string, id: string, input: Parameters<typeof ledger.advanceInvoiceCase>[3]) {
    const result = ledger.advanceInvoiceCase(this.db, actorId, id, input, this.clock.now())
    this.commit()
    return result
  }
  // ---------- Nexus conversations ----------
  // Private to the account and the company it acts for. Nothing said here becomes a
  // company fact: these methods only ever touch conversations and chatMessages.

  private conversation(actor: User, id: string): Conversation {
    const c = this.db.conversations.find((x) => x.id === id)
    // Someone else's conversation is reported as missing, never as forbidden.
    if (!c || c.ownerUserId !== actor.id || c.orgId !== actor.orgId) {
      throw new NexusError('NOT_FOUND', '会话不存在或无权访问')
    }
    return c
  }

  private pushChat(c: Conversation, role: ChatRole, body: string, runtime: string | null): ChatMessage {
    const now = this.clock.now()
    const m: ChatMessage = { id: uid('chat'), conversationId: c.id, role, body, runtime, createdAt: now }
    this.db.chatMessages.push(m)
    c.updatedAt = now
    return m
  }

  /** A conversation is only stored once it has a first message; empty drafts are not kept. */
  startConversation(actorId: string, firstMessage: string): { conversation: Conversation; message: ChatMessage } {
    const actor = this.user(actorId)
    const body = requireText(firstMessage, '消息内容', CHAT_MESSAGE_MAX)
    const now = this.clock.now()
    const conversation: Conversation = {
      id: uid('cv'),
      ownerUserId: actor.id,
      orgId: actor.orgId,
      title: conversationTitle(body),
      createdAt: now,
      updatedAt: now
    }
    this.db.conversations.push(conversation)
    const message = this.pushChat(conversation, 'user', body, null)
    this.commit()
    return { conversation, message }
  }

  addChatMessage(actorId: string, conversationId: string, text: string): ChatMessage {
    const actor = this.user(actorId)
    const c = this.conversation(actor, conversationId)
    const m = this.pushChat(c, 'user', requireText(text, '消息内容', CHAT_MESSAGE_MAX), null)
    this.commit()
    return m
  }

  /** Store what the runtime returned. Only the owner's own conversation can receive it. */
  recordRuntimeReply(actorId: string, conversationId: string, reply: RuntimeReply): ChatMessage {
    const actor = this.user(actorId)
    const c = this.conversation(actor, conversationId)
    if (reply.role !== 'system' && reply.role !== 'assistant') throw new NexusError('INVALID_INPUT', '回复类型无效')
    const m = this.pushChat(c, reply.role, String(reply.body ?? '').slice(0, 20_000), String(reply.runtime ?? 'unknown').slice(0, 40))
    m.references = reply.references
    m.profileUpdate = reply.profileUpdate
    this.commit()
    return m
  }

  confirmProfileUpdate(actorId: string, messageId: string): void {
    const actor = this.user(actorId)
    const message = this.db.chatMessages.find((m) => m.id === messageId)
    if (!message) throw new NexusError('NOT_FOUND', '修改草稿不存在')
    this.conversation(actor, message.conversationId)
    const draft = message.profileUpdate
    if (message.role !== 'assistant' || !draft || draft.appliedAt) throw new NexusError('CONFLICT', '草稿不可用或已处理')
    const org = this.db.organizations.find((o) => o.id === actor.orgId)!
    if ((org.profile?.updatedAt ?? null) !== draft.baseUpdatedAt) throw new NexusError('CONFLICT', '公司资料已在草稿生成后修改，请重新提出修改')
    this.updateCompanyProfile(actorId, draft.values)
    draft.appliedAt = this.clock.now()
    this.commit()
  }

  renameConversation(actorId: string, conversationId: string, title: string): Conversation {
    const actor = this.user(actorId)
    const c = this.conversation(actor, conversationId)
    c.title = requireText(title, '会话名称', CHAT_TITLE_MAX)
    c.updatedAt = this.clock.now()
    this.commit()
    return c
  }
}
