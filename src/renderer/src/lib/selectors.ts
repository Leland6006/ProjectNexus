import type { Contract, Directory, Organization, Transaction, User, ViewState } from '@shared/types'
import { effectiveOrgId, isOwnerMember, isPartyMember } from '@shared/permissions'

export function currentUser(s: ViewState): User {
  return s.users.find((u) => u.id === s.currentUserId)!
}

/**
 * Organisation / account list for directory-style views. The demo build ships the full
 * list in `demoAccounts`; when this runs against a server it is null and the caller
 * falls back to the already-filtered organisations and users.
 */
export function directory(s: ViewState): Directory {
  return s.demoAccounts ?? { organizations: s.organizations, users: s.users }
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
  const orgId = effectiveOrgId(user, tx, s.representingOrgId)
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

export interface CounterpartyGroup {
  orgId: string
  name: string
  transactions: Transaction[]
}

/**
 * Visible businesses grouped by the organisation on the other side. The counterparty is
 * only a grouping key: each business keeps its own contracts, messages and payments.
 */
export function counterpartyGroups(s: ViewState): CounterpartyGroup[] {
  const groups = new Map<string, CounterpartyGroup>()
  for (const t of s.transactions) {
    const other = otherPartyId(t, accessFor(s, t).orgId)
    const g = groups.get(other) ?? { orgId: other, name: orgOf(s, other)?.name ?? '未知企业', transactions: [] }
    g.transactions.push(t)
    groups.set(other, g)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * Organisations that granted the current external counsel access, across every
 * transaction they can see. More than one means the counsel has to pick a side.
 */
export function counselGrantOrgIds(s: ViewState): string[] {
  const ids = new Set<string>()
  for (const t of s.transactions) {
    for (const g of t.counselGrants) {
      if (g.userId === s.currentUserId) ids.add(g.grantedByOrgId)
    }
  }
  return [...ids]
}
