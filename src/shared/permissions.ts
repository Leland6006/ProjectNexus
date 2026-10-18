// Permission model for the local DEMO. Pure functions, no I/O.
// This is NOT real authentication: it only demonstrates how data isolation between
// organisations and external counsel would work once a real backend exists.

import type {
  Contract,
  Database,
  Transaction,
  User,
  ViewState,
  Visibility
} from './types.ts'

/**
 * The organisation a user acts for within a transaction, or null if the user
 * has no access to the transaction at all.
 * - Party members act for their own organisation (counterparty only once invited).
 * - External counsel act for the organisation that granted them access.
 */
export function effectiveOrgId(user: User, tx: Transaction): string | null {
  if (user.role === 'external_counsel') {
    return tx.counselGrants.find((g) => g.userId === user.id)?.grantedByOrgId ?? null
  }
  if (user.orgId === tx.initiatorOrgId) return tx.initiatorOrgId
  if (user.orgId === tx.counterpartyOrgId && tx.counterpartyStatus !== 'none') {
    return tx.counterpartyOrgId
  }
  return null
}

export function canViewTransaction(user: User, tx: Transaction): boolean {
  return effectiveOrgId(user, tx) !== null
}

/** Non-counsel member of one of the two transaction parties. */
export function isPartyMember(user: User, tx: Transaction): boolean {
  return user.role !== 'external_counsel' && effectiveOrgId(user, tx) !== null
}

/** Non-counsel member of the organisation that initiated (owns) the transaction. */
export function isOwnerMember(user: User, tx: Transaction): boolean {
  return user.role !== 'external_counsel' && user.orgId === tx.initiatorOrgId
}

export function canViewContract(user: User, tx: Transaction, contract: Contract): boolean {
  const org = effectiveOrgId(user, tx)
  if (!org) return false
  if (org === tx.initiatorOrgId) return true
  return contract.sharedWithCounterparty
}

/** Item-level visibility, evaluated after transaction/contract access is confirmed. */
export function canSeeItem(
  user: User,
  tx: Transaction,
  item: { orgId: string; visibility: Visibility }
): boolean {
  const org = effectiveOrgId(user, tx)
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
  createdAt: string
): boolean {
  if (!contract) return false
  const org = effectiveOrgId(user, tx)
  if (org === tx.initiatorOrgId) return true
  return contract.sharedAt !== null && createdAt >= contract.sharedAt
}

/** Everything a given user is allowed to see. The renderer never receives more than this. */
export function buildViewState(db: Database, userId: string): ViewState {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`Unknown user: ${userId}`)

  const txById = new Map(db.transactions.map((t) => [t.id, t]))
  // Redact counsel grants: a party must never learn who the other side authorised.
  const transactions = db.transactions
    .filter((t) => canViewTransaction(user, t))
    .map((t) => {
      const org = effectiveOrgId(user, t)
      return {
        ...t,
        counselGrants: t.counselGrants.filter(
          (g) => g.grantedByOrgId === org && (user.role !== 'external_counsel' || g.userId === user.id)
        )
      }
    })

  const contracts = db.contracts.filter((c) => {
    const tx = txById.get(c.transactionId)
    return !!tx && canViewContract(user, tx, c)
  })
  const contractById = new Map(contracts.map((c) => [c.id, c]))

  const inVisibleContract = <T extends { contractId: string; createdAt: string }>(item: T): boolean => {
    const contract = contractById.get(item.contractId)
    const tx = contract && txById.get(contract.transactionId)
    return !!contract && !!tx && afterShare(user, tx, contract, item.createdAt)
  }

  const versions = db.versions.filter(inVisibleContract)

  const comments = db.comments.filter((c) => {
    if (!inVisibleContract(c)) return false
    const tx = txById.get(contractById.get(c.contractId)!.transactionId)!
    return canSeeItem(user, tx, c)
  })

  // Suggestions are always proposals between the two parties.
  const suggestions = db.suggestions.filter(inVisibleContract)

  const visibleTxIds = new Set(transactions.map((t) => t.id))

  const messages = db.messages.filter((m) => {
    const tx = txById.get(m.transactionId)
    return !!tx && visibleTxIds.has(m.transactionId) && canSeeItem(user, tx, m)
  })

  const milestones = db.milestones.filter((m) => visibleTxIds.has(m.transactionId))

  const activities = db.activities.filter((a) => {
    const tx = txById.get(a.transactionId)
    if (!tx || !visibleTxIds.has(a.transactionId)) return false
    if (!canSeeItem(user, tx, a)) return false
    if (a.contractId) {
      const contract = contractById.get(a.contractId)
      return !!contract && afterShare(user, tx, contract, a.createdAt)
    }
    return true
  })

  return {
    currentUserId: userId,
    // Directory of demo accounts, needed by the account switcher.
    organizations: db.organizations,
    users: db.users,
    transactions,
    contracts,
    versions,
    comments,
    suggestions,
    messages,
    milestones,
    activities
  }
}
