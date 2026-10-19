// Storage schema migrations.
//
// V0.1 shipped with `schemaVersion: 1` and no upgrade path: any file whose version did
// not match was archived and replaced by demo data, which would silently destroy real
// user data the moment the schema moved to 2. This module owns the version history so
// that old files are upgraded step by step instead.
//
// It lives in src/shared (no I/O, no Electron) so a future server can reuse the exact
// same migration chain against PostgreSQL-backed data.

import type { Database } from './types.ts'

/** Bump this whenever `Database` changes shape, and add the matching step below. */
export const CURRENT_SCHEMA_VERSION = 7

/**
 * Files written before versioning existed carry no `schemaVersion`. They are treated as
 * version 0 and get the same normalisation the first versioned release produced.
 */
const UNVERSIONED = 0

export interface MigrationStep {
  from: number
  to: number
  /** Mutates `db` in place; must also set `db.schemaVersion = to`. */
  up: (db: Database) => void
}

function loose(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/**
 * Ordered upgrade steps. Append a new step every time `CURRENT_SCHEMA_VERSION` moves.
 */
export const MIGRATIONS: MigrationStep[] = [
  {
    // Files written before versioning existed already match the v1 shape.
    from: UNVERSIONED,
    to: 1,
    up: (db) => {
      db.schemaVersion = 1
    }
  },
  {
    // V0.2: structured payment terms, cost items, cash accounts, claims, proposals.
    from: 1,
    to: 2,
    up: (db) => {
      db.costItems ??= []
      db.cashAccounts ??= []
      db.claims ??= []
      db.proposals ??= []
      for (const c of db.contracts) if (loose(c).paymentTerms === undefined) loose(c).paymentTerms = null
      for (const v of db.versions) if (loose(v).paymentTerms === undefined) loose(v).paymentTerms = null
      db.schemaVersion = 2
    }
  },
  {
    // Round 1 framework: private Nexus conversations. Existing data is untouched.
    from: 2,
    to: 3,
    up: (db) => {
      db.conversations ??= []
      db.chatMessages ??= []
      db.schemaVersion = 3
    }
  },
  {
    from: 3, to: 4,
    up: (db) => {
      for (const org of db.organizations) org.profile ??= null
      for (const p of db.proposals) if (p.status === 'pending') p.invalidatedReason = '资金计算口径已升级，请核对付款方、预计验收日与余额后重新分析。'
      db.schemaVersion = 4
    }
  },
  {
    from: 4, to: 5,
    up: (db) => {
      db.analysisRuns ??= []
      db.tasks ??= []
      db.schemaVersion = 5
    }
  },
  {
    from: 5, to: 6,
    up: (db) => {
      db.counterparties ??= []
      db.importDrafts ??= []
      db.internalReviews ??= []
      db.schemaVersion = 6
    }
  },
  {
    from: 6, to: 7,
    up: (db) => {
      db.cashPlans ??= []
      db.cashEntries ??= []
      db.invoiceCases ??= []
      db.schemaVersion = 7
    }
  }
]

/** Structural check: enough to trust the file before running migrations on it. */
export function looksLikeDatabase(value: unknown): value is Database {
  if (typeof value !== 'object' || value === null) return false
  const db = value as Partial<Record<keyof Database, unknown>>
  const arrays: (keyof Database)[] = [
    'organizations',
    'users',
    'transactions',
    'contracts',
    'versions',
    'comments',
    'suggestions',
    'messages',
    'milestones',
    'activities'
  ]
  if (typeof db.schemaVersion === 'number' && db.schemaVersion >= 2) {
    arrays.push('proposals', 'claims', 'costItems', 'cashAccounts')
  }
  if (typeof db.schemaVersion === 'number' && db.schemaVersion >= 3) {
    arrays.push('conversations', 'chatMessages')
  }
  if (typeof db.schemaVersion === 'number' && db.schemaVersion >= 5) arrays.push('analysisRuns', 'tasks')
  if (typeof db.schemaVersion === 'number' && db.schemaVersion >= 6) arrays.push('counterparties', 'importDrafts', 'internalReviews')
  if (typeof db.schemaVersion === 'number' && db.schemaVersion >= 7) arrays.push('cashPlans', 'cashEntries', 'invoiceCases')
  return arrays.every((k) => Array.isArray(db[k]))
}

export type MigrationResult =
  | { ok: true; db: Database; fromVersion: number }
  | { ok: false; reason: string }

/**
 * Bring a raw parsed database up to `CURRENT_SCHEMA_VERSION`.
 * Returns `ok: false` (never a half-migrated database) when the file is from a newer
 * app release or when a required step is missing.
 */
export function migrateDatabase(raw: unknown, targetVersion: number = CURRENT_SCHEMA_VERSION): MigrationResult {
  if (!looksLikeDatabase(raw)) return { ok: false, reason: '数据文件结构不符合预期' }

  const db = raw
  const declared = Number.isInteger(db.schemaVersion) ? db.schemaVersion : UNVERSIONED

  if (declared > targetVersion) {
    return { ok: false, reason: `数据文件来自更新的版本（v${declared}），请升级应用后再打开` }
  }

  // Pre-versioning file: start it at 0 so it walks the same chain as everyone else.
  let version = declared
  while (version < targetVersion) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) return { ok: false, reason: `缺少从 v${version} 升级到 v${targetVersion} 的迁移步骤` }
    step.up(db)
    if (db.schemaVersion !== step.to) db.schemaVersion = step.to
    version = step.to
  }

  if (!looksLikeDatabase(db)) return { ok: false, reason: '迁移后的数据文件结构不符合预期' }
  return { ok: true, db, fromVersion: declared }
}
