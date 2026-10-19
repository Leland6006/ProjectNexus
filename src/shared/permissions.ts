// Permission model for the local DEMO. Pure functions, no I/O.
// This is NOT real authentication: it only demonstrates how data isolation between
// organisations and external counsel would work once a real backend exists.

import type {
  Contract,
  Database,
  Organization,
  RuntimeStatus,
  Transaction,
  User,
  ViewState,
  Visibility
} from './types.ts'

// NOTE: do not import ./context.ts here — context depends on this module. The claim
// filter below is intentionally inlined so the dependency stays one-way.

/**
 * Organisations that granted an external counsel access to a transaction.
 * Empty for everyone else.
 */
export function counselGrantOrgIds(user: User, tx: Transaction): string[] {
  if (user.role !== 'external_counsel') return []
  return tx.counselGrants.filter((g) => g.userId === user.id).map((g) => g.grantedByOrgId)
}

/**
 * The organisation a user acts for within a transaction, or null if the user
 * has no access to the transaction at all.
 * - Party members act for their own organisation (counterparty only once invited).
 * - External counsel act for the organisation that granted them access. When both
 *   parties granted them access they must say which one they are acting for
 *   (`asOrgId`); without it the first grant wins, which is only a fallback.
 */
export function effectiveOrgId(user: User, tx: Transaction, asOrgId?: string | null): string | null {
  if (user.role === 'external_counsel') {
    const grants = counselGrantOrgIds(user, tx)
    if (grants.length === 0) return null
    if (asOrgId && grants.includes(asOrgId)) return asOrgId
    return grants[0]
  }
  if (user.orgId === tx.initiatorOrgId) return tx.initiatorOrgId
  if (user.orgId === tx.counterpartyOrgId && tx.counterpartyStatus !== 'none') {
    return tx.counterpartyOrgId
  }
  return null
}

export function canViewTransaction(user: User, tx: Transaction, asOrgId?: string | null): boolean {
  return effectiveOrgId(user, tx, asOrgId) !== null
}

/** Non-counsel member of one of the two transaction parties. */
export function isPartyMember(user: User, tx: Transaction): boolean {
  return user.role !== 'external_counsel' && effectiveOrgId(user, tx) !== null
}

/** Non-counsel member of the organisation that initiated (owns) the transaction. */
export function isOwnerMember(user: User, tx: Transaction): boolean {
  return user.role !== 'external_counsel' && user.orgId === tx.initiatorOrgId
}

export function canViewContract(user: User, tx: Transaction, contract: Contract, asOrgId?: string | null): boolean {
  const org = effectiveOrgId(user, tx, asOrgId)
  if (!org) return false
  if (org === tx.initiatorOrgId) return true
  return contract.sharedWithCounterparty
}

/** Item-level visibility, evaluated after transaction/contract access is confirmed. */
export function canSeeItem(
  user: User,
  tx: Transaction,
  item: { orgId: string; visibility: Visibility },
  asOrgId?: string | null
): boolean {
  const org = effectiveOrgId(user, tx, asOrgId)
  if (!org) return false
  switch (item.visibility) {
    case 'shared':
      return true
    case 'internal':
      // Internal discussion: author's organisation only, never external counsel.
      return user.role !== 'external_counsel' && org === item.orgId
    case 'counsel':
      // Author's organisation plus counsel that organisation granted.
      return org === item.orgId
  }
}

/** Counterparty-side viewers cannot see anything created before the contract was shared. */
function afterShare(
  user: User,
  tx: Transaction,
  contract: Contract | undefined,
  createdAt: string,
  asOrgId?: string | null
): boolean {
  if (!contract) return false
  const org = effectiveOrgId(user, tx, asOrgId)
  if (org === tx.initiatorOrgId) return true
  return contract.sharedAt !== null && createdAt >= contract.sharedAt
}

export interface ViewOptions {
  /**
   * Organisation an external counsel is currently acting for. Required for counsel who
   * were granted access by both parties, otherwise they silently see only the first
   * grant's data.
   */
  representingOrgId?: string | null
  /**
   * Local demo only: also return every demo account so the account switcher can list
   * them. A server must never set this.
   */
  demoDirectory?: boolean
  /** Conversation runtime installed in the host. Defaults to "nothing connected". */
  runtime?: RuntimeStatus
}

/** Everything a given user is allowed to see. The renderer never receives more than this. */
export function buildViewState(db: Database, userId: string, opts: ViewOptions = {}): ViewState {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`Unknown user: ${userId}`)
  const asOrgId = opts.representingOrgId ?? null

  const txById = new Map(db.transactions.map((t) => [t.id, t]))
  // Redact counsel grants: a party must never learn who the other side authorised.
  const transactions = db.transactions
    .filter((t) => canViewTransaction(user, t, asOrgId))
    .map((t) => {
      const org = effectiveOrgId(user, t, asOrgId)
      return {
        ...t,
        counselGrants: t.counselGrants.filter(
          (g) => g.grantedByOrgId === org && (user.role !== 'external_counsel' || g.userId === user.id)
        )
      }
    })

  const contracts = db.contracts.filter((c) => {
    const tx = txById.get(c.transactionId)
    return !!tx && canViewContract(user, tx, c, asOrgId)
  })
  const contractById = new Map(contracts.map((c) => [c.id, c]))

  const inVisibleContract = <T extends { contractId: string; createdAt: string }>(item: T): boolean => {
    const contract = contractById.get(item.contractId)
    const tx = contract && txById.get(contract.transactionId)
    return !!contract && !!tx && afterShare(user, tx, contract, item.createdAt, asOrgId)
  }

  const versions = db.versions.filter(inVisibleContract)

  const comments = db.comments.filter((c) => {
    if (!inVisibleContract(c)) return false
    const tx = txById.get(contractById.get(c.contractId)!.transactionId)!
    return canSeeItem(user, tx, c, asOrgId)
  })

  // Suggestions are always proposals between the two parties.
  const suggestions = db.suggestions.filter(inVisibleContract)

  const visibleTxIds = new Set(transactions.map((t) => t.id))

  const messages = db.messages.filter((m) => {
    const tx = txById.get(m.transactionId)
    return !!tx && visibleTxIds.has(m.transactionId) && canSeeItem(user, tx, m, asOrgId)
  })

  const milestones = db.milestones.filter((m) => visibleTxIds.has(m.transactionId))

  const costItems = db.costItems.filter((c) => {
    const tx = txById.get(c.transactionId)
    return !!tx && visibleTxIds.has(c.transactionId) && canSeeItem(user, tx, c, asOrgId)
  })

  const cashAccounts = db.cashAccounts.filter((a) => a.orgId === user.orgId)

  const claims = db.claims.filter((c) => {
    if (c.transactionId === null) return c.orgId === user.orgId
    const tx = txById.get(c.transactionId)
    return !!tx && visibleTxIds.has(c.transactionId) && canSeeItem(user, tx, c, asOrgId)
  })

  const proposals = db.proposals.filter((p) => {
    const tx = txById.get(p.transactionId)
    if (!tx || !visibleTxIds.has(p.transactionId)) return false
    // Proposals contain derived internal financial information, including their prose.
    return user.role !== 'external_counsel' && effectiveOrgId(user, tx, asOrgId) === p.orgId &&
      (!p.contractId || contractById.has(p.contractId))
  })

  const activities = db.activities.filter((a) => {
    const tx = txById.get(a.transactionId)
    if (!tx || !visibleTxIds.has(a.transactionId)) return false
    if (!canSeeItem(user, tx, a, asOrgId)) return false
    if (a.contractId) {
      const contract = contractById.get(a.contractId)
      return !!contract && afterShare(user, tx, contract, a.createdAt, asOrgId)
    }
    return true
  })

  // Conversations are private to the account and to the company it acts for. A colleague
  // in the same company does not see them, and neither does anybody else.
  const conversations = db.conversations.filter((c) => c.ownerUserId === user.id && c.orgId === user.orgId)
  const conversationIds = new Set(conversations.map((c) => c.id))
  const chatMessages = db.chatMessages.filter((m) => conversationIds.has(m.conversationId))

  // Directory: only organisations and people the user legitimately deals with. Sending
  // the whole user table to every client would leak the customer list once this runs on
  // a server. Anyone whose content is visible must stay resolvable, otherwise the UI
  // would render "unknown user" next to text the user is allowed to read.
  const relatedOrgIds = new Set<string>([user.orgId])
  const knownUserIds = new Set<string>([user.id])
  for (const t of transactions) {
    relatedOrgIds.add(t.initiatorOrgId)
    relatedOrgIds.add(t.counterpartyOrgId)
    knownUserIds.add(t.createdBy)
  }
  for (const t of db.transactions) {
    for (const g of t.counselGrants) {
      if (g.userId === user.id) relatedOrgIds.add(g.grantedByOrgId)
    }
  }
  for (const c of comments) knownUserIds.add(c.authorId)
  for (const s of suggestions) {
    knownUserIds.add(s.authorId)
    if (s.resolvedBy) knownUserIds.add(s.resolvedBy)
  }
  for (const m of messages) knownUserIds.add(m.authorId)
  for (const v of versions) knownUserIds.add(v.authorId)
  for (const a of activities) knownUserIds.add(a.actorId)
  for (const m of milestones) knownUserIds.add(m.createdBy)

  // Also keep the organisation of everybody we just referenced.
  for (const u of db.users) {
    if (knownUserIds.has(u.id)) relatedOrgIds.add(u.orgId)
  }

  const organizations: Organization[] = db.organizations.filter((o) => relatedOrgIds.has(o.id))
  const users = db.users.filter((u) => relatedOrgIds.has(u.orgId) || knownUserIds.has(u.id))

  return {
    currentUserId: userId,
    representingOrgId: user.role === 'external_counsel' ? asOrgId : null,
    organizations,
    users,
    demoAccounts: opts.demoDirectory ? { organizations: db.organizations, users: db.users } : null,
    transactions,
    contracts,
    versions,
    comments,
    suggestions,
    messages,
    milestones,
    activities,
    costItems,
    cashAccounts,
    claims,
    proposals,
    conversations,
    chatMessages,
    runtime: opts.runtime ?? { id: 'none', connected: false }
  }
}
