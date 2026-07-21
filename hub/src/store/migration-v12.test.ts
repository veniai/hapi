import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('migration v11 → v12 (attention_rev + handled_rev)', () => {
    it('fresh DB has attention/handled rev columns in sessions table', () => {
        const store = new Store(':memory:')
        const columns = (store['db'].prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
            .map((r) => r.name)
        expect(columns).toContain('attention_rev')
        expect(columns).toContain('handled_rev')
        const uv = (store['db'].prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        expect(uv).toBe(13)
        store.close()
    })

    it('V11 → V12 adds NOT NULL DEFAULT 0 columns (real upgrade path, file DB)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v12-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            // Build a real V11-shaped DB on disk: fresh V13 schema, strip the rev
            // columns (V11 has none), add last_read (V11 still has them), set uv=11.
            // :memory: can't be used — close+reopen on :memory: yields a fresh DB
            // (createSchema), not the migration ladder, so the upgrade path would
            // never actually run.
            store = new Store(dbPath)
            store['db'].exec('ALTER TABLE sessions DROP COLUMN attention_rev')
            store['db'].exec('ALTER TABLE sessions DROP COLUMN handled_rev')
            store['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_message_id TEXT')
            store['db'].exec('ALTER TABLE sessions ADD COLUMN last_read_at INTEGER')
            store['db'].exec('PRAGMA user_version = 11')
            store.close()

            // Reopen → initSchema runs the ladder from V11:
            // migrateFromV11ToV12 ADDs attention_rev/handled_rev (NOT NULL DEFAULT 0),
            // then migrateFromV12ToV13 DROPs last_read. Verifies the ADD path.
            store = new Store(dbPath)
            const cols = store['db'].prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string; dflt_value: string | null; notnull: number }>
            const att = cols.find((c) => c.name === 'attention_rev')
            const hnd = cols.find((c) => c.name === 'handled_rev')
            expect(att).toBeDefined()
            expect(hnd).toBeDefined()
            expect(att!.dflt_value).toBe('0')
            expect(hnd!.dflt_value).toBe('0')
            expect(att!.notnull).toBe(1)
            expect(hnd!.notnull).toBe(1)
            const uv = (store['db'].prepare('PRAGMA user_version').get() as { user_version: number }).user_version
            expect(uv).toBe(13)
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('bumpAttentionRev increments monotonically and returns null for missing session', () => {
        const store = new Store(':memory:')
        const ns = 'default'
        const session = store.sessions.getOrCreateSession('tag', { path: '', host: '' }, null, ns)
        expect(session.attentionRev).toBe(0)

        const r1 = store.sessions.bumpAttentionRev(session.id, ns)
        const r2 = store.sessions.bumpAttentionRev(session.id, ns)
        expect(r1).toBe(1)
        expect(r2).toBe(2)

        const missing = store.sessions.bumpAttentionRev('nope', ns)
        expect(missing).toBeNull()
        store.close()
    })

    it('advanceHandledRev catches up to attention_rev and is idempotent', () => {
        const store = new Store(':memory:')
        const ns = 'default'
        const session = store.sessions.getOrCreateSession('tag', { path: '', host: '' }, null, ns)
        // Two attention events → attention_rev = 2, handled still 0.
        store.sessions.bumpAttentionRev(session.id, ns)
        store.sessions.bumpAttentionRev(session.id, ns)

        const advanced = store.sessions.advanceHandledRev(session.id, ns, 2)
        expect(advanced?.handledRev).toBe(2)
        expect(advanced?.changed).toBe(true)

        // Second advance with no new attention → no-op.
        const idempotent = store.sessions.advanceHandledRev(session.id, ns, 2)
        expect(idempotent?.handledRev).toBe(2)
        expect(idempotent?.changed).toBe(false)
        store.close()
    })

    it('red-dot invariant: new attention after send re-lights (attentionRev > handledRev)', () => {
        const store = new Store(':memory:')
        const ns = 'default'
        const session = store.sessions.getOrCreateSession('tag', { path: '', host: '' }, null, ns)
        // Attention event + send (handled catches up) → invariant equal, no dot.
        store.sessions.bumpAttentionRev(session.id, ns)
        store.sessions.advanceHandledRev(session.id, ns, 1)
        let after = store.sessions.getSession(session.id)!
        expect(after.attentionRev).toBe(after.handledRev)

        // New agent result after the send → attention pulls ahead → dot lights.
        store.sessions.bumpAttentionRev(session.id, ns)
        after = store.sessions.getSession(session.id)!
        expect(after.attentionRev).toBeGreaterThan(after.handledRev)
        store.close()
    })
})
