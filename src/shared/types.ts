// Core domain model for Project Nexus V0.1.
// All data is fictional demo data. Local roles are a DEMO of a permission model,
// NOT real authentication or production-grade security.

export type OrgKind = 'company' | 'law_firm'

export interface Organization {
  id: string
  name: string
  kind: OrgKind
  shortName: string
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

export interface Contract {
  id: string
  transactionId: string
  title: string
  status: ContractStatus
  clauses: Clause[]
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
