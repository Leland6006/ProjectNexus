// Typed navigation for the two-level layout: module -> object in that module -> work.
// Pure (no React, no path aliases, type-only imports) so it can be unit-tested with Node.

export type ModuleId = 'nexus' | 'actions' | 'business' | 'finance' | 'memory' | 'settings'

export type ActionsView = 'overview' | 'attention' | 'decisions' | 'executing' | 'done'
export type FinanceView = 'overview' | 'receivables' | 'records' | 'costs' | 'invoices'
export type MemoryView = 'profile' | 'confirmed' | 'unverified' | 'library' | 'members'
export type ProjectTab = 'overview' | 'collab' | 'performance' | 'money'

export type Route =
  | { module: 'nexus'; conversationId: string | null }
  | { module: 'actions'; view: ActionsView }
  | { module: 'business'; view: 'all'; create?: boolean }
  | { module: 'business'; view: 'archived' }
  | { module: 'business'; view: 'contracts' }
  | { module: 'business'; view: 'counterparty'; orgId: string }
  | { module: 'business'; view: 'project'; transactionId: string; tab: ProjectTab }
  | { module: 'business'; view: 'contract'; contractId: string }
  | { module: 'finance'; view: FinanceView }
  | { module: 'memory'; view: MemoryView }
  | { module: 'settings' }

/** Start page: a fresh Nexus conversation. */
export const HOME: Route = { module: 'nexus', conversationId: null }

export function defaultRoute(module: ModuleId): Route {
  switch (module) {
    case 'nexus':
      return HOME
    case 'actions':
      return { module: 'actions', view: 'overview' }
    case 'business':
      return { module: 'business', view: 'all' }
    case 'finance':
      return { module: 'finance', view: 'overview' }
    case 'memory':
      return { module: 'memory', view: 'profile' }
    case 'settings':
      return { module: 'settings' }
  }
}

export function projectRoute(transactionId: string, tab: ProjectTab = 'overview'): Route {
  return { module: 'business', view: 'project', transactionId, tab }
}

export function contractRoute(contractId: string): Route {
  return { module: 'business', view: 'contract', contractId }
}

export function isContractRoute(r: Route): boolean {
  return r.module === 'business' && r.view === 'contract'
}

/** What to remember per module: one-shot flags (such as "open the create dialog") are dropped. */
export function rememberable(r: Route): Route {
  if (r.module === 'business' && r.view === 'all' && r.create) return { module: 'business', view: 'all' }
  return r
}

/** Where an attention item is handled. Structural input so this file stays dependency-free. */
export function attentionRoute(item: { kind: 'decision' | 'suggestion' | 'milestone'; transactionId: string; contractId: string | null }): Route {
  if (item.kind === 'decision') return { module: 'actions', view: 'decisions' }
  if (item.kind === 'suggestion' && item.contractId) return { module: 'business', view: 'contract', contractId: item.contractId }
  return { module: 'business', view: 'project', transactionId: item.transactionId, tab: item.kind === 'milestone' ? 'performance' : 'overview' }
}

/** Ids the current account can see. Built from the already-filtered view state. */
export interface VisibleIds {
  conversations: string[]
  transactions: string[]
  contracts: string[]
  /** Organisations that are the other side of at least one visible business. */
  counterparties: string[]
}

/**
 * Keep a route only while its object is still visible. After an account switch, a
 * permission change or a reset, a route that points at something the account may no
 * longer see falls back to the module's default page instead of rendering stale data.
 */
export function reconcileRoute(route: Route, v: VisibleIds): Route {
  if (route.module === 'nexus') {
    return route.conversationId && !v.conversations.includes(route.conversationId) ? HOME : route
  }
  if (route.module === 'business') {
    if (route.view === 'project' && !v.transactions.includes(route.transactionId)) return defaultRoute('business')
    if (route.view === 'contract' && !v.contracts.includes(route.contractId)) return defaultRoute('business')
    if (route.view === 'counterparty' && !v.counterparties.includes(route.orgId)) return defaultRoute('business')
  }
  return route
}
