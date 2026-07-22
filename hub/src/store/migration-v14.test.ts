import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V13→V14 schema migration: add FTS5 full-text index over
 * messages.content (multi-agent-blackboard #3). external-content FTS5 keyed by
 * the implicit rowid (messages.id is UUID TEXT and cannot be content_rowid).
 * Triggers keep the index in sync; CASCADE session deletes fire AFTER DELETE on
 * messages automatically. See doc/spec/multi-agent-blackboard-v1.1-impl.md ①.
 */
describe('migration v13 → v14 (FTS5 index over messages.content)', () => {
    it('fresh DB has messages_fts + 3 triggers + user_version=14', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get()).toBeDefined()
        const trigs = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts_%'").all() as Array<{ name: string }>).map((t) => t.name).sort()
        expect(trigs).toEqual(['messages_fts_ad', 'messages_fts_ai', 'messages_fts_au'])
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(14)
        store.close()
    })

    it('V13 → V14 backfills existing messages (searchable after migration)', () => {
        const { store, dir } = openV13WithMessages()
        try {
            const db = (store as any).db as Database
            expect(matchCount(db, 'backfill')).toBe(1)
            expect(matchCount(db, 'gamma')).toBe(1)
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(14)
        } finally {
            store.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('idempotent: reopen V14 DB is a no-op', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v14-idem-'))
        const dbPath = join(dir, 'test.db')
        const s1 = new Store(dbPath)
        s1.close()
        const s2 = new Store(dbPath)
        try {
            const db = (s2 as any).db as Database
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(14)
            expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get()).toBeDefined()
        } finally {
            s2.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('trigger: INSERT message → MATCH; DELETE → cleared', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1')
        insertMsg(db, 'm1', 's1', 'hello alpha token', 1)
        expect(matchCount(db, 'alpha')).toBe(1)
        db.exec("DELETE FROM messages WHERE id='m1'")
        expect(matchCount(db, 'alpha')).toBe(0)
        store.close()
    })

    it('trigger: UPDATE content reindexes (old term gone, new term present)', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1')
        insertMsg(db, 'm1', 's1', 'hello alpha', 1)
        db.prepare("UPDATE messages SET content = ? WHERE id='m1'")
            .run(JSON.stringify({ role: 'user', content: 'changed to beta' }))
        expect(matchCount(db, 'alpha')).toBe(0)
        expect(matchCount(db, 'beta')).toBe(1)
        store.close()
    })

    it('CASCADE: delete session → messages + FTS cleared', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        db.exec('PRAGMA foreign_keys = ON')
        seedSession(db, 's1')
        insertMsg(db, 'm1', 's1', 'cascade target word', 1)
        expect(matchCount(db, 'cascade')).toBe(1)
        db.exec("DELETE FROM sessions WHERE id='s1'")
        expect((db.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c).toBe(0)
        expect(matchCount(db, 'cascade')).toBe(0)
        store.close()
    })

    it('rebuild: full reindex from messages is safe', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1')
        insertMsg(db, 'm1', 's1', 'rebuild test word', 1)
        db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        expect(matchCount(db, 'rebuild')).toBe(1)
        store.close()
    })
})

function seedSession(db: Database, id: string): void {
    db.prepare('INSERT INTO sessions (id, namespace, created_at, updated_at) VALUES (?,?,?,?)')
        .run(id, 'default', 1, 1)
}

function insertMsg(db: Database, id: string, sid: string, text: string, seq: number): void {
    db.prepare('INSERT INTO messages (id, session_id, content, created_at, seq) VALUES (?,?,?,?,?)')
        .run(id, sid, JSON.stringify({ role: 'user', content: text }), 1, seq)
}

function matchCount(db: Database, term: string): number {
    return (db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH '${term}'`).all() as unknown[]).length
}

/**
 * Build a V13-shaped DB (fresh V14 schema, then drop the FTS virtual table +
 * triggers and set user_version=13) with seeded messages, then reopen so
 * initSchema runs migrateFromV13ToV14 — the rebuild backfill must index the
 * pre-existing rows.
 */
function openV13WithMessages(): { store: Store; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v14-'))
    const dbPath = join(dir, 'test.db')
    const seed = new Store(dbPath)
    const db = (seed as any).db as Database
    db.exec('DROP TRIGGER IF EXISTS messages_fts_au')
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ad')
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ai')
    db.exec('DROP TABLE IF EXISTS messages_fts')
    seedSession(db, 's1')
    insertMsg(db, 'm1', 's1', 'backfill me alpha', 1)
    insertMsg(db, 'm2', 's1', 'second beta gamma', 2)
    db.exec('PRAGMA user_version = 13')
    seed.close()
    const store = new Store(dbPath)
    return { store, dir }
}
