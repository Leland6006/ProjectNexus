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
export const CURRENT_SCHEMA_VERSION = 1

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

/**
 * Ordered upgrade steps. Empty while the schema is at version 1 — add entries here as
 * the model evolves, e.g.
 *
 *   { from: 1, to: 2, up: (db) => { db.attachments = []; db.schemaVersion = 2 } }
 */
export const MIGRATIONS: MigrationStep[] = []

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

  // Pre-versioning file: it already matches the shape version 1 introduced.
  if (declared === UNVERSIONED) {
    db.schemaVersion = targetVersion
    return { ok: true, db, fromVersion: declared }
  }

  let version = declared
  while (version < targetVersion) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) return { ok: false, reason: `缺少从 v${version} 升级到 v${targetVersion} 的迁移步骤` }
    step.up(db)
    if (db.schemaVersion !== step.to) db.schemaVersion = step.to
    version = step.to
  }

  return { ok: true, db, fromVersion: declared }
}
