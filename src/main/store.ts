// Local persistence: one JSON file with atomic writes (write temp file, then rename).
// Deliberately free of Electron imports so it can be unit-tested with plain Node.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSeedDatabase, DEFAULT_USER_ID } from '../shared/seed.ts'
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
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>
      const db = parsed.db
      if (!db || db.schemaVersion !== 1 || !Array.isArray(db.transactions) || !Array.isArray(db.users)) {
        throw new Error('unexpected data shape')
      }
      const userOk = db.users.some((u) => u.id === parsed.currentUserId)
      return { db, currentUserId: userOk ? parsed.currentUserId! : DEFAULT_USER_ID }
    } catch (err) {
      // Keep the unreadable file for inspection instead of silently destroying it.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        renameSync(this.file, backup)
      } catch {
        /* ignore */
      }
      console.error(`[store] could not read data file (${(err as Error).message}); moved to ${backup}`)
      return this.fresh()
    }
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
