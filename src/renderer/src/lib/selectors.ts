import type { Contract, Organization, Transaction, User, ViewState } from '@shared/types'
import { effectiveOrgId, isOwnerMember, isPartyMember } from '@shared/permissions'

export function currentUser(s: ViewState): User {
  return s.users.find((u) => u.id === s.currentUserId)!
}

export function orgOf(s: ViewState, id: string): Organization | undefined {
  return s.organizations.find((o) => o.id === id)
}

export function userOf(s: ViewState, id: string): User | undefined {
  return s.users.find((u) => u.id === id)
}

/** Name to display for a user, with organisation. */
export function userLabel(s: ViewState, id: string): string {
  const u = userOf(s, id)
  if (!u) return '未知用户'
  const o = orgOf(s, u.orgId)
  return `${u.name}（${o?.shortName ?? ''}）`
}

export interface Access {
  /** Organisation the current user is acting for in this transaction. */
  orgId: string | null
  isOwner: boolean
  isParty: boolean
  isCounsel: boolean
  isCounterparty: boolean
}

export function accessFor(s: ViewState, tx: Transaction): Access {
  const user = currentUser(s)
  const orgId = effectiveOrgId(user, tx)
  return {
    orgId,
    isOwner: isOwnerMember(user, tx),
    isParty: isPartyMember(user, tx),
    isCounsel: user.role === 'external_counsel',
    isCounterparty: orgId === tx.counterpartyOrgId
  }
}

export function txOfContract(s: ViewState, c: Contract): Transaction | undefined {
  return s.transactions.find((t) => t.id === c.transactionId)
}

export function otherPartyId(tx: Transaction, myOrgId: string | null): string {
  return myOrgId === tx.initiatorOrgId ? tx.counterpartyOrgId : tx.initiatorOrgId
}
