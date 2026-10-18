// Rules the contract editor UI depends on.
//
// These used to live inline inside ContractEditor.tsx, which made them impossible to
// test without a DOM. They are pure and DOM-free, so `npm test` covers them directly and
// the component only has to render the answer.

import type { Clause, Comment, ContractVersion, Suggestion, Visibility } from './types.ts'

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  shared: '双方可见',
  internal: '仅本企业（对方与律师不可见）',
  counsel: '本企业及其外部律师'
}

export const COUNSEL_VISIBILITY_LABEL = '仅委托企业及其律师'

/** A freshly appended clause, numbered after the existing ones. */
export function newClause(clauses: Clause[], makeId: () => string): Clause {
  return { id: makeId(), title: `第${clauses.length + 1}条 新条款`, body: '<p></p>' }
}

export interface ClauseBadges {
  comments: number
  pendingSuggestions: number
}

/** Counters shown next to a clause in the outline. */
export function clauseBadges(
  comments: Comment[],
  suggestions: Suggestion[],
  contractId: string,
  clauseId: string
): ClauseBadges {
  return {
    comments: comments.filter((c) => c.contractId === contractId && c.clauseId === clauseId).length,
    pendingSuggestions: suggestions.filter(
      (s) => s.contractId === contractId && s.clauseId === clauseId && s.status === 'pending'
    ).length
  }
}

/**
 * Visibility scopes a comment author may choose.
 * - External counsel may only write for the organisation that engaged them.
 * - `shared` needs a contract the other party can actually see.
 * - A reply cannot widen the audience of its parent thread.
 */
export function visibilityOptions(opts: {
  isCounsel: boolean
  canShare: boolean
  replyAudience?: Visibility | null
}): Visibility[] {
  if (opts.isCounsel) return ['counsel']
  const out: Visibility[] = []
  if (opts.canShare && (!opts.replyAudience || opts.replyAudience === 'shared')) out.push('shared')
  out.push('internal', 'counsel')
  return out
}

/** Clamp a reply's visibility to the scope of the comment being replied to. */
export function replyVisibility(parent: Visibility | null | undefined, chosen: Visibility): Visibility {
  if (parent && parent !== 'shared' && chosen === 'shared') return parent
  return chosen
}

/** Whether the current user may confirm the latest version as final. */
export function canConfirmFinal(o: {
  isParty: boolean
  shared: boolean
  locked: boolean
  hasLatest: boolean
  alreadyConfirmed: boolean
  dirty: boolean
}): boolean {
  if (!o.isParty || !o.shared || o.locked || !o.hasLatest) return false
  return !o.alreadyConfirmed && !o.dirty
}

/** Versions newest first. Returns a copy so callers never sort shared state in place. */
export function sortVersionsDesc(versions: ContractVersion[]): ContractVersion[] {
  return [...versions].sort((a, b) => b.number - a.number)
}

/** The version immediately before `selected`, or undefined when it is the first one. */
export function previousVersion(versionsDesc: ContractVersion[], selected: ContractVersion | undefined): ContractVersion | undefined {
  if (!selected) return undefined
  return versionsDesc.find((v) => v.number === selected.number - 1)
}
