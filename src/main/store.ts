// Local persistence: one JSON file with atomic writes (write temp file, then rename).
// Deliberately free of Electron imports so it can be unit-tested with plain Node.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSeedDatabase, DEFAULT_USER_ID } from '../shared/seed.ts'
import { migrateDatabase } from '../shared/migrations.ts'
import type { Database } from '../shared/types.ts'

export interface PersistedState {
  db: Database
  currentUserId: string
}

const FILE_NAME = 'nexus-data.json'

export class JsonStore {
  private readonly file: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: PersistedState | null = null

  constructor(dir: string) {
    this.file = join(dir, FILE_NAME)
    mkdirSync(dirname(this.file), { recursive: true })
  }

  get path(): string {
    return this.file
  }

  load(): PersistedState {
    if (!existsSync(this.file)) return this.fresh()

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      return this.archiveAndReset(err, 'corrupt')
    }

    const db = (parsed as { db?: unknown } | null)?.db
    const migrated = migrateDatabase(db)
    if (!migrated.ok) return this.archiveAndReset(new Error(migrated.reason), 'incompatible')

    const declared = (parsed as { currentUserId?: unknown }).currentUserId
    const currentUserId =
      typeof declared === 'string' && migrated.db.users.some((u) => u.id === declared)
        ? declared
        : DEFAULT_USER_ID
    const state: PersistedState = { db: migrated.db, currentUserId }

    // Persist an upgrade immediately so a crash cannot leave the old file in place.
    if (migrated.fromVersion !== migrated.db.schemaVersion) this.writeNow(state)
    return state
  }

  /** Keep the unusable file for inspection instead of silently destroying it. */
  private archiveAndReset(err: unknown, reason: 'corrupt' | 'incompatible'): PersistedState {
    const backup = `${this.file}.${reason}-${Date.now()}`
    try {
      renameSync(this.file, backup)
    } catch {
      /* ignore */
    }
    console.error(`[store] could not use data file (${(err as Error).message}); moved to ${backup}`)
    return this.fresh()
  }

  private fresh(): PersistedState {
    const state: PersistedState = { db: createSeedDatabase(), currentUserId: DEFAULT_USER_ID }
    this.writeNow(state)
    return state
  }

  /** Debounced save so bursts of edits produce one disk write. */
  save(state: PersistedState): void {
    this.pending = state
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pending) this.writeNow(this.pending)
    }, 150)
  }

  /** Flush immediately (used on quit). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending) this.writeNow(this.pending)
  }

  private writeNow(state: PersistedState): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
    this.pending = null
  }
}
