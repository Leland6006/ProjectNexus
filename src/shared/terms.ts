import type { Clause } from './types.ts'

// Change detector only, never an authorization or cryptographic signature.
export function clausesFingerprint(clauses: Clause[]): string {
  const text = JSON.stringify(clauses.map((c) => [c.id, c.title, c.body]))
  let a = 2166136261, b = 5381
  for (let n = 0; n < text.length; n++) {
    a = Math.imul(a ^ text.charCodeAt(n), 16777619)
    b = Math.imul(b, 33) ^ text.charCodeAt(n)
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`
}

/** Internal review applies to this exact saved working copy and version history. */
export function reviewFingerprint(contract: import('./types.ts').Contract, versions: import('./types.ts').ContractVersion[]): string {
  return JSON.stringify([clausesFingerprint(contract.clauses), contract.title, contract.paymentTerms, versions.filter((v) => v.contractId === contract.id).map((v) => v.id)])
}


/** Once an enterprise asks for review, its latest requests must pass for the current draft. */
export function internalReviewBlocker(contract: import('./types.ts').Contract, versions: import('./types.ts').ContractVersion[], reviews: import('./types.ts').InternalReview[], orgId: string): string | null {
  const latest = new Map<string, import('./types.ts').InternalReview>()
  for (const r of reviews) if (r.contractId === contract.id && r.orgId === orgId) latest.set(r.reviewerId, r)
  const source = reviewFingerprint(contract, versions)
  for (const r of latest.values()) {
    if (r.sourceFingerprint !== source) return '合同已更新，请重新发起内部审阅并通过后再确认最终版'
    if (r.status !== 'approved') return '请完成本企业内部审阅并通过后再确认最终版'
  }
  return null
}
