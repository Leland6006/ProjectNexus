// Version comparison: clause-level matching plus word/character-level text diff.
// Pure functions, no dependencies.

import type { Clause } from './types.ts'

export type DiffOp = 'equal' | 'insert' | 'delete'

export interface DiffSegment {
  op: DiffOp
  text: string
}

export type ClauseChange = 'added' | 'removed' | 'modified' | 'unchanged'

export interface ClauseDiff {
  clauseId: string
  title: string
  change: ClauseChange
  titleSegments: DiffSegment[]
  bodySegments: DiffSegment[]
}

/** Convert the editor's simple HTML to plain text, keeping paragraph breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Tokenise so that Chinese text diffs per character, Latin words / numbers stay whole,
 * and whitespace/punctuation are separate tokens.
 */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+|\s+|[一-鿿]|[^\sA-Za-z0-9_一-鿿]/g) ?? []
}

/**
 * Largest DP table we are willing to allocate (cells). The table is Uint32, so this caps
 * the temporary allocation at roughly 4 MB.
 */
const MAX_DP_CELLS = 1_000_000

/** Longest-common-subsequence diff over tokens. */
export function diffTokens(a: string[], b: string[]): DiffSegment[] {
  // Trim the shared head and tail first. Contract edits usually touch one clause inside a
  // long document, so this keeps the quadratic table proportional to the changed region
  // instead of to the whole text. Trimming is exact: it cannot change the LCS.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tailA = a.length
  let tailB = b.length
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--
    tailB--
  }

  const segments: DiffSegment[] = []
  const push = (op: DiffOp, text: string): void => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.op === op) last.text += text
    else segments.push({ op, text })
  }

  push('equal', a.slice(0, head).join(''))
  for (const seg of diffCore(a.slice(head, tailA), b.slice(head, tailB))) push(seg.op, seg.text)
  push('equal', a.slice(tailA).join(''))
  return segments
}

/** LCS over the already-trimmed token ranges. */
function diffCore(a: string[], b: string[]): DiffSegment[] {
  const n = a.length
  const m = b.length
  // Guard against pathological sizes: fall back to a whole-block replace.
  if (n * m > MAX_DP_CELLS) {
    const out: DiffSegment[] = []
    if (n) out.push({ op: 'delete', text: a.join('') })
    if (m) out.push({ op: 'insert', text: b.join('') })
    return out
  }

  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const segments: DiffSegment[] = []
  const push = (op: DiffOp, text: string): void => {
    const last = segments[segments.length - 1]
    if (last && last.op === op) last.text += text
    else segments.push({ op, text })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('delete', a[i++])
    } else {
      push('insert', b[j++])
    }
  }
  while (i < n) push('delete', a[i++])
  while (j < m) push('insert', b[j++])
  return segments
}

export function diffText(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) return oldText ? [{ op: 'equal', text: oldText }] : []
  return diffTokens(tokenize(oldText), tokenize(newText))
}

/** Compare two versions of a contract clause by clause (matched on clause id). */
export function diffClauses(oldClauses: Clause[], newClauses: Clause[]): ClauseDiff[] {
  const oldById = new Map(oldClauses.map((c) => [c.id, c]))
  const newById = new Map(newClauses.map((c) => [c.id, c]))
  const result: ClauseDiff[] = []

  for (const next of newClauses) {
    const prev = oldById.get(next.id)
    const newText = htmlToText(next.body)
    if (!prev) {
      result.push({
        clauseId: next.id,
        title: next.title,
        change: 'added',
        titleSegments: [{ op: 'insert', text: next.title }],
        bodySegments: newText ? [{ op: 'insert', text: newText }] : []
      })
      continue
    }
    const oldText = htmlToText(prev.body)
    const changed = prev.title !== next.title || oldText !== newText
    result.push({
      clauseId: next.id,
      title: next.title,
      change: changed ? 'modified' : 'unchanged',
      titleSegments: diffText(prev.title, next.title),
      bodySegments: diffText(oldText, newText)
    })
  }

  for (const prev of oldClauses) {
    if (newById.has(prev.id)) continue
    const oldText = htmlToText(prev.body)
    result.push({
      clauseId: prev.id,
      title: prev.title,
      change: 'removed',
      titleSegments: [{ op: 'delete', text: prev.title }],
      bodySegments: oldText ? [{ op: 'delete', text: oldText }] : []
    })
  }
  return result
}

export function summarizeDiff(diffs: ClauseDiff[]): {
  added: number
  removed: number
  modified: number
  unchanged: number
} {
  const s = { added: 0, removed: 0, modified: 0, unchanged: 0 }
  for (const d of diffs) s[d.change]++
  return s
}
