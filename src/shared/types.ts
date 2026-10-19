// Core domain model for Project Nexus V0.1.
// All data is fictional demo data. Local roles are a DEMO of a permission model,
// NOT real authentication or production-grade security.

export type OrgKind = 'company' | 'law_firm'

export interface CompanyProfile {
  industry: string
  business: string
  goal: string
  stage: string
  teamSize: number | null
  region: string
  updatedAt: string
  updatedBy: string
}

export interface Organization {
  localOnly?: boolean
  ownerOrgId?: string
  id: string
  name: string
  kind: OrgKind
  shortName: string
  profile?: CompanyProfile | null
}

export type UserRole = 'business' | 'legal' | 'external_counsel'

export interface User {
  id: string
  name: string
  orgId: string
  role: UserRole
  title: string
}

export type TransactionStatus =
  | 'draft'
  | 'negotiating'
  | 'pending_signature'
  | 'in_performance'
  | 'completed'
  | 'cancelled'

export type CounterpartyStatus = 'none' | 'invited' | 'joined'

export interface CounselGrant {
  userId: string
  grantedByOrgId: string
  grantedByUserId: string
  grantedAt: string
}

export interface Transaction {
  id: string
  name: string
  type: string
  initiatorOrgId: string
  counterpartyOrgId: string
  amount: number
  currency: 'CNY'
  expectedSignDate: string
  description: string
  status: TransactionStatus
  counterpartyStatus: CounterpartyStatus
  counselGrants: CounselGrant[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type ContractStatus = 'draft' | 'negotiating' | 'finalized'

export interface Clause {
  id: string
  title: string
  /** Simple HTML produced by the Tiptap editor (paragraphs, lists, bold/italic). */
  body: string
}

export interface PaymentInstalment {
  id: string
  label: string
  /** Share of the contract amount, 0..1. */
  rate: number
  dueDate: string
}

/**
 * The machine-readable mirror of the contract's payment clause.
 *
 * A text diff can only report "clause 6 changed"; it cannot produce the numbers an
 * agent needs to reason about cash. Keeping the commercial terms as structured fields
 * (edited through a form, rendered into the clause text) is what makes event-driven
 * cross-domain analysis possible without asking a model to parse prose.
 */
export interface PaymentTerms {
  /** Share paid up front, 0..1. */
  prepayRate: number
  instalments: PaymentInstalment[]
  /** Days between acceptance and final settlement. */
  settlementDays: number
  /** Required for reliable forecasts; null means not yet verified. */
  verifiedClausesFingerprint?: string
  payerOrgId?: string | null
  acceptanceDate?: string | null
}

export interface Contract {
  id: string
  transactionId: string
  title: string
  status: ContractStatus
  clauses: Clause[]
  /** Structured payment terms; null until they have been filled in. */
  paymentTerms: PaymentTerms | null
  /** Whether the counterparty organisation may see this contract. */
  sharedWithCounterparty: boolean
  /** When the contract was shared; counterparty only sees history from this moment on. */
  sharedAt: string | null
  /** Version id the parties confirmed as final, if any. */
  finalVersionId: string | null
  finalConfirmedBy: string[] // org ids that confirmed
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ContractVersion {
  id: string
  contractId: string
  number: number
  label: string
  note: string
  clauses: Clause[]
  /** Snapshot of the structured terms at this version, so terms can be diffed. */
  paymentTerms: PaymentTerms | null
  authorId: string
  createdAt: string
}

/**
 * shared   : both transaction parties (and counsel of either party)
 * internal : only the author's organisation (NOT external counsel)
 * counsel  : author's organisation incl. its granted external counsel
 */
export type Visibility = 'shared' | 'internal' | 'counsel'

export interface Comment {
  id: string
  contractId: string
  clauseId: string
  parentId: string | null
  authorId: string
  /** Organisation on whose behalf the author wrote this (counsel -> granting org). */
  orgId: string
  body: string
  visibility: Visibility
  createdAt: string
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

export interface Suggestion {
  id: string
  contractId: string
  clauseId: string
  authorId: string
  orgId: string
  originalBody: string
  proposedBody: string
  reason: string
  status: SuggestionStatus
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
}

export interface Message {
  id: string
  transactionId: string
  authorId: string
  orgId: string
  body: string
  visibility: Exclude<Visibility, 'counsel'>
  createdAt: string
}

export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'delayed'

export interface Milestone {
  id: string
  transactionId: string
  name: string
  responsibleOrgId: string
  dueDate: string
  status: MilestoneStatus
  note: string
  /** Payment amount in CNY for payment milestones, otherwise 0. */
  paymentAmount: number
  createdBy: string
  createdAt: string
}

export type CostStatus = 'planned' | 'committed' | 'paid'

/**
 * Cash the company expects to pay out to deliver a transaction. V0.1 had收款侧 only
 * (Milestone.paymentAmount); without the cost side no cash-flow question is answerable.
 */
export interface CostItem {
  id: string
  transactionId: string
  /** Organisation bearing the cost, which also decides who may see it. */
  orgId: string
  name: string
  amount: number
  dueDate: string
  status: CostStatus
  visibility: Visibility
  createdBy: string
  createdAt: string
  updatedAt?: string
}

export interface CashAccount {
  id: string
  orgId: string
  label: string
  /** Cash on hand at `asOf`. */
  openingBalance: number
  asOf: string
  updatedAt?: string
  updatedBy?: string
}

/**
 * Epistemic status. This is the single most important field in the context engine:
 * a model's guess must never be stored the same way as a signed contract term.
 *
 * confirmed   : read from a source of truth (contract, ledger, user-confirmed input)
 * inferred    : derived or predicted by an agent or a projection; needs confirmation
 * recommended : an action somebody should take
 *
 * Only a human may promote `inferred`/`recommended` to `confirmed`.
 */
export type ClaimStatus = 'confirmed' | 'inferred' | 'recommended'

export interface ClaimSource {
  kind: 'contract' | 'transaction' | 'ledger' | 'user' | 'agent'
  /** Contract id, cost item id, agent id, ... depending on `kind`. */
  ref?: string
  detail?: string
}

/**
 * One unit of company memory. Claims are the only thing agents are allowed to read;
 * they never receive the raw database.
 */
export interface Claim {
  id: string
  orgId: string
  /** null for company-wide facts. */
  transactionId: string | null
  /** Stable semantic key (`payment.prepay_rate`) so re-runs update instead of duplicate. */
  key: string
  label: string
  value: string
  numeric: number | null
  unit: string | null
  status: ClaimStatus
  source: ClaimSource
  asOf: string
  visibility: Visibility
  supersededById: string | null
  confirmedBy: string | null
  confirmedAt: string | null
}

export type DomainEventType = 'payment_terms_changed' | 'cost_committed' | 'milestone_delayed' | 'business_review_requested'

/**
 * A business change worth reacting to. Payload holds numbers, not prose, so the
 * routing rules can branch on them deterministically.
 */
export interface DomainEvent {
  id: string
  type: DomainEventType
  transactionId: string
  contractId: string | null
  at: string
  summary: string
  payload: Record<string, number | string | null>
  visibility: Visibility
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface ProposedAction {
  kind: 'counter_offer' | 'revise_clause' | 'add_task' | 'contact_counterparty'
  title: string
  detail: string
  clauseId?: string | null
  proposedBody?: string | null
}

/**
 * An agent-written draft. Nothing happens until a human approves it, and approval is
 * refused if the contract moved on in the meantime (`baseVersionId`).
 */
export interface Proposal {
  analysisRunId?: string | null
  executionSuggestionIds?: string[]
  invalidatedReason?: string | null
  id: string
  transactionId: string
  contractId: string | null
  orgId: string
  title: string
  rationale: string
  actions: ProposedAction[]
  /** Findings this draft rests on. All of them must be visible to the approver. */
  claimIds: string[]
  eventId: string | null
  status: ProposalStatus
  /** `agent:main` for agent drafts, a user id when drafted by hand. */
  createdBy: string
  createdAt: string
  resolvedBy: string | null
  resolvedAt: string | null
  /** Newest version when the draft was written; approval fails once it is stale. */
  baseVersionId: string | null
}

export type ActivityType =
  | 'transaction_created'
  | 'transaction_updated'
  | 'counterparty_invited'
  | 'counterparty_joined'
  | 'counsel_invited'
  | 'contract_created'
  | 'contract_shared'
  | 'contract_edited'
  | 'version_saved'
  | 'version_restored'
  | 'comment_added'
  | 'comment_replied'
  | 'suggestion_created'
  | 'suggestion_accepted'
  | 'suggestion_rejected'
  | 'final_confirmed'
  | 'message_sent'
  | 'milestone_created'
  | 'milestone_updated'
  | 'proposal_created'
  | 'proposal_approved'
  | 'proposal_rejected'

export interface Activity {
  id: string
  transactionId: string
  contractId: string | null
  actorId: string
  orgId: string
  type: ActivityType
  summary: string
  visibility: Visibility
  createdAt: string
}

/**
 * A private working conversation with Nexus. It belongs to one account acting for one
 * operating company; nobody else can open it, including colleagues in the same company.
 * What is said here is discussion only and never becomes company memory by itself.
 */
export interface Conversation {
  id: string
  ownerUserId: string
  /** Operating company the conversation belongs to (the owner's organisation). */
  orgId: string
  title: string
  createdAt: string
  updatedAt: string
}

/**
 * user      : typed by the owner
 * system    : a status notice written by Nexus itself (for example "AI not connected").
 *             It reports what happened; it is never advice or analysis.
 * assistant : a reply produced by a configured runtime.
 */
export type ChatRole = 'user' | 'system' | 'assistant'

export interface DataReference {
  id: string
  label: string
  detail: string
}

export interface ProfileUpdateDraft {
  values: Omit<CompanyProfile, 'updatedAt' | 'updatedBy'>
  baseUpdatedAt: string | null
  appliedAt?: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: ChatRole
  body: string
  /** Runtime that produced a non-user message ('none' when no AI is connected). */
  runtime: string | null
  references?: DataReference[]
  profileUpdate?: ProfileUpdateDraft
  createdAt: string
}

export type SpecialistId = 'finance' | 'legal' | 'ops' | 'main'
export interface AnalysisStep {
  agentId: SpecialistId
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
  findings: string[]
  recommendation: string | null
  claims: Claim[]
  contextKeys: string[]
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface AnalysisRun {
  id: string
  orgId: string
  transactionId: string
  createdBy: string
  status: 'running' | 'paused' | 'failed' | 'completed' | 'stale' | 'cancelled'
  trigger: string
  event: DomainEvent | null
  sourceRevision: string
  provider: string
  steps: AnalysisStep[]
  proposalId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type TaskStatus = 'open' | 'in_progress' | 'waiting_user' | 'paused' | 'completed' | 'cancelled'
export interface TaskStep {
  id: string
  title: string
  status: 'pending' | 'completed'
  result: string | null
  completedBy: string | null
  completedAt: string | null
}
export interface BusinessTask {
  id: string
  orgId: string
  transactionId: string
  contractId: string | null
  proposalId: string | null
  actionIndex: number | null
  title: string
  detail: string
  ownerUserId: string
  dueDate: string | null
  status: TaskStatus
  revision: number
  requiresReview: boolean
  steps: TaskStep[]
  history: { at: string; actorId: string; summary: string }[]
  createdAt: string
  updatedAt: string
}

export interface Counterparty {
  id: string
  orgId: string
  name: string
  contactName: string
  email: string
  createdAt: string
}

export interface ContractImportDraft {
  id: string
  orgId: string
  createdBy: string
  fileName: string
  rawText: string
  candidates: { field: 'partyA' | 'partyB' | 'amount' | 'date'; value: string; quote: string }[]
  warnings: string[]
  status: 'pending' | 'confirmed'
  contractId: string | null
  createdAt: string
}

export interface InternalReview {
  id: string
  orgId: string
  transactionId: string
  contractId: string
  requestedBy: string
  reviewerId: string
  sourceFingerprint: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt: string
  decidedAt: string | null
}

export interface CashPlan {
  id: string
  orgId: string
  transactionId: string | null
  costItemId: string | null
  title: string
  direction: 'in' | 'out'
  amount: number
  dueDate: string
  status: 'active' | 'cancelled'
  revision: number
  createdBy: string
  updatedAt: string
}

export interface CashEntry {
  id: string
  orgId: string
  requestId: string
  accountId: string
  planId: string | null
  transactionId: string | null
  direction: 'in' | 'out'
  amount: number
  date: string
  note: string
  evidence: string
  status: 'posted' | 'void'
  voidReason: string | null
  createdBy: string
  createdAt: string
  voidedBy: string | null
  voidedAt: string | null
}

export interface InvoiceCase {
  id: string
  orgId: string
  transactionId: string
  title: string
  buyerName: string
  buyerTaxId: string
  itemName: string
  amount: number
  note: string
  stage: 'materials' | 'checked' | 'submitted' | 'recorded'
  invoiceNumber: string | null
  result: string | null
  revision: number
  history: { at: string; actorId: string; summary: string }[]
  createdAt: string
}

export interface Database {
  /** Storage schema version; see src/shared/migrations.ts for the upgrade chain. */
  schemaVersion: number
  organizations: Organization[]
  users: User[]
  transactions: Transaction[]
  contracts: Contract[]
  versions: ContractVersion[]
  comments: Comment[]
  suggestions: Suggestion[]
  messages: Message[]
  milestones: Milestone[]
  activities: Activity[]
  costItems: CostItem[]
  cashAccounts: CashAccount[]
  claims: Claim[]
  proposals: Proposal[]
  conversations: Conversation[]
  chatMessages: ChatMessage[]
  analysisRuns: AnalysisRun[]
  tasks: BusinessTask[]
  counterparties: Counterparty[]
  importDrafts: ContractImportDraft[]
  internalReviews: InternalReview[]
  cashPlans: CashPlan[]
  cashEntries: CashEntry[]
  invoiceCases: InvoiceCase[]
}

/** Which conversation runtime is installed in the main process. The UI never guesses. */
export interface RuntimeStatus {
  id: string
  connected: boolean
  model?: string
}

/** Organisations and accounts, used by the demo directory views. */
export interface Directory {
  organizations: Organization[]
  users: User[]
}

/** What the renderer receives: already filtered for the acting user. */
export interface ViewState {
  currentUserId: string
  /** Organisation an external counsel is currently acting for; null for everybody else. */
  representingOrgId: string | null
  organizations: Organization[]
  users: User[]
  /**
   * Full account list for the demo account switcher. Populated only in the local demo
   * build; a server must leave this null so tenants cannot enumerate each other.
   */
  demoAccounts: Directory | null
  transactions: Transaction[]
  contracts: Contract[]
  versions: ContractVersion[]
  comments: Comment[]
  suggestions: Suggestion[]
  messages: Message[]
  milestones: Milestone[]
  activities: Activity[]
  costItems: CostItem[]
  /** Only the acting user's own accounts: the other side's cash position is theirs. */
  cashAccounts: CashAccount[]
  /** Company memory. Filtered by visibility, same as every other item. */
  claims: Claim[]
  /** Agent drafts waiting for a human decision. */
  proposals: Proposal[]
  /** Only the acting account's own conversations in its own company. */
  conversations: Conversation[]
  chatMessages: ChatMessage[]
  analysisRuns: AnalysisRun[]
  tasks: BusinessTask[]
  counterparties: Counterparty[]
  importDrafts: ContractImportDraft[]
  internalReviews: InternalReview[]
  cashPlans: CashPlan[]
  cashEntries: CashEntry[]
  invoiceCases: InvoiceCase[]
  runtime: RuntimeStatus
}

export type NexusErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'

export class NexusError extends Error {
  code: NexusErrorCode
  constructor(code: NexusErrorCode, message: string) {
    super(message)
    this.name = 'NexusError'
    this.code = code
  }
}

export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  draft: '草稿',
  negotiating: '协商中',
  pending_signature: '待签署',
  in_performance: '履行中',
  completed: '已完成',
  cancelled: '已取消'
}

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  delayed: '已延期'
}

export const ROLE_LABEL: Record<UserRole, string> = {
  business: '商务',
  legal: '法务',
  external_counsel: '外部律师'
}
