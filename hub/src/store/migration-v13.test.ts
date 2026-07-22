import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V12→V13 schema migration: DROP last_read_message_id + last_read_at.
 * The read-position feature was reverted (commit 5ffc151); single-device
 * restore runs via TanStack Router scrollRestoration, these columns have no
 * live writers/readers after the cleanup. Red-dot columns (attention_rev /
 * handled_rev, V12) MUST survive.
 */
describe('migration v12 → v13 (drop last_read_message_id + last_read_at)', () => {
    it('fresh DB has NO last_read columns + user_version=13', () => {
        const store = new Store(':memory:')
        const cols = getSessionColumns(store)
        expect(cols).not.toContain('last_read_message_id')
        expect(cols).not.toContain('last_read_at')
        const uv = (store['db'].prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        expect(uv).toBe(14)
        store.close()
    })

    it('V12 → V13 drops last_read columns', () => {
        const { store, dir } = openV12AndMigrate()
        try {
            const cols = getSessionColumns(store)
            expect(cols).not.toContain('last_read_message_id')
            expect(cols).not.toContain('last_read_at')
            const uv = (store['db'].prepare('PRAGMA user_version').get() as { user_version: number }).user_version
            expect(uv).toBe(14)
        } finally {
            store.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('idempotent: reopen V13 DB is a no-op (schema unchanged, no throw)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v13-idempotent-'))
        const dbPath = join(dir, 'test.db')
        let s1: Store | undefined
        let s2: Store | undefined
        try {
            s1 = new Store(dbPath)
            const cols1 = getSessionColumns(s1)
            s1.close()
            // Reopen — already V13, migrateFromV12ToV13 must be a no-op (PRAGMA guard).
            s2 = new Store(dbPath)
            const cols2 = getSessionColumns(s2)
            expect(cols2).toEqual(cols1)
            expect(cols2).not.toContain('last_read_message_id')
        } finally {
            s2?.close()
            s1?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('red-dot invariant: attention_rev / handled_rev survive V12→V13', () => {
        const { store, dir } = openV12AndMigrate()
        try {
            const cols = getSessionColumns(store)
            expect(cols).toContain('attention_rev')
            expect(cols).toContain('handled_rev')
        } finally {
            store.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('data integrity: existing session rows survive the drop, rev values preserved', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v13-data-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            // Seed a V12 DB with a session row carrying rev values + last_read.
            store = new Store(dbPath)
            store['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_message_id TEXT')
            store['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_at INTEGER')
            store['db'].exec(
                `INSERT INTO sessions (id, namespace, created_at, updated_at, seq, attention_rev, handled_rev, last_read_message_id, last_read_at)
                 VALUES ('s1', 'default', 1000, 1000, 0, 5, 3, 'm-x', 9999)`,
            )
            store['db'].exec('PRAGMA user_version = 12')
            store.close()

            // Reopen → migrateFromV12ToV13 drops last_read columns.
            store = new Store(dbPath)
            const s = store.sessions.getSession('s1')
            expect(s).toBeDefined()
            expect(s?.attentionRev).toBe(5)
            expect(s?.handledRev).toBe(3)
            const cols = getSessionColumns(store)
            expect(cols).not.toContain('last_read_message_id')
            expect(cols).not.toContain('last_read_at')
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function getSessionColumns(store: Store): string[] {
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    return rows.map((r) => r.name)
}

/**
 * Build a V12-shaped DB on disk (fresh V13 schema + ADD last_read columns +
 * user_version=12), then reopen via Store so initSchema runs migrateFromV12ToV13.
 */
function openV12AndMigrate(): { store: Store; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v13-'))
    const dbPath = join(dir, 'test.db')
    const seed = new Store(dbPath)
    seed['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_message_id TEXT')
    seed['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_at INTEGER')
    seed['db'].exec('PRAGMA user_version = 12')
    seed.close()
    const store = new Store(dbPath)
    return { store, dir }
}
