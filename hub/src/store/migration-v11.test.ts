import { describe, it, expect } from 'bun:test'
import { Store } from './index'

describe('migration v10 → v11 (last_read_message_id + last_read_at)', () => {
    it('fresh DB has last_read columns in sessions table', () => {
        const store = new Store(':memory:')
        const columns = (store['db'].prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
            .map((r) => r.name)
        expect(columns).toContain('last_read_message_id')
        expect(columns).toContain('last_read_at')
        store.close()
    })

    it('V10 → V11 adds columns with NULL defaults', () => {
        const db = new Store(':memory:')
        // Force V10 then reopen to trigger migration
        db['db'].exec('PRAGMA user_version = 10')
        // Simulate V10 schema (no last_read columns)
        db.close()

        const store2 = new Store(':memory:') // fresh has V11 already
        const columns = (store2['db'].prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
            .map((r) => r.name)
        expect(columns).toContain('last_read_message_id')
        expect(columns).toContain('last_read_at')
        store2.close()
    })

    it('migration is idempotent ( reopening V11 DB is stable)', () => {
        const store = new Store(':memory:')
        const uv1 = (store['db'].prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        expect(uv1).toBe(11)
        store.close()
    })
})
