import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'
import { searchMessages } from './searchMessages'

describe('searchMessages (FTS5, namespace + workspace scoped)', () => {
    it('matches message content and ranks by bm25 (more hits → more relevant)', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/p', undefined, undefined, 'Button sizing')
        insertMsg(db, 'm1', 's1', 'alpha beta', 1)
        insertMsg(db, 'm2', 's1', 'alpha alpha gamma', 2)
        const hits = searchMessages(db, 'ns1', '/p', 'alpha')
        expect(hits.length).toBe(2)
        expect(hits[0].messageId).toBe('m2') // alpha appears twice → more relevant
        expect(hits[0].sessionName).toBe('Button sizing')
        store.close()
    })

    it('falls back from session name to summary, worktree name, then path', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 'summary', 'ns1', '/summary', undefined, undefined, undefined, 'Summary title')
        insertMsg(db, 'm-summary', 'summary', 'fallback summary', 1)
        seedSession(db, 'worktree', 'ns1', '/worktree', undefined, '/worktree', undefined, undefined, 'send')
        insertMsg(db, 'm-worktree', 'worktree', 'fallback worktree', 1)
        seedSession(db, 'path', 'ns1', '/path')
        insertMsg(db, 'm-path', 'path', 'fallback path', 1)

        expect(searchMessages(db, 'ns1', '/summary', 'fallback')[0].sessionName).toBe('Summary title')
        expect(searchMessages(db, 'ns1', '/worktree', 'fallback')[0].sessionName).toBe('send')
        expect(searchMessages(db, 'ns1', '/path', 'fallback')[0].sessionName).toBe('/path')
        store.close()
    })

    it('namespace isolation: ns1 query does NOT return ns2 messages (IDOR guard)', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/p')
        insertMsg(db, 'm1', 's1', 'shared keyword alpha', 1)
        seedSession(db, 's2', 'ns2', '/p')
        insertMsg(db, 'm2', 's2', 'shared keyword alpha', 1)
        const ns1Hits = searchMessages(db, 'ns1', '/p', 'keyword')
        expect(ns1Hits.length).toBe(1)
        expect(ns1Hits[0].messageId).toBe('m1')
        expect(ns1Hits.some((h) => h.sessionId === 's2')).toBe(false)
        store.close()
    })

    it('path scoping: same namespace, different project paths do not cross', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/proj-a')
        insertMsg(db, 'm1', 's1', 'target word here', 1)
        seedSession(db, 's2', 'ns1', '/proj-b')
        insertMsg(db, 'm2', 's2', 'target word here', 1)
        const hits = searchMessages(db, 'ns1', '/proj-a', 'target')
        expect(hits.length).toBe(1)
        expect(hits[0].sessionId).toBe('s1')
        store.close()
    })

    it('groups HAPI worktrees by workspacePath', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/worktrees/one', '/repo')
        insertMsg(db, 'm1', 's1', 'shared workspace result', 1)
        seedSession(db, 's2', 'ns1', '/worktrees/two', undefined, '/repo')
        insertMsg(db, 'm2', 's2', 'shared workspace result', 1)

        const hits = searchMessages(db, 'ns1', '/repo', 'workspace')
        expect(hits.map((hit) => hit.sessionId)).toEqual(['s1', 's2'])
        store.close()
    })

    it('excludes the session that issued the search', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 'current', 'ns1', '/p', '/repo')
        insertMsg(db, 'm1', 'current', 'shared workspace result', 1)
        seedSession(db, 'sibling', 'ns1', '/other', '/repo')
        insertMsg(db, 'm2', 'sibling', 'shared workspace result', 1)

        const hits = searchMessages(db, 'ns1', '/repo', 'workspace', 20, 'current')
        expect(hits.map((hit) => hit.sessionId)).toEqual(['sibling'])
        store.close()
    })

    it('empty result for a term that does not occur', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/p')
        insertMsg(db, 'm1', 's1', 'alpha beta', 1)
        expect(searchMessages(db, 'ns1', '/p', 'nonexistentterm').length).toBe(0)
        store.close()
    })

    it('respects the limit argument', () => {
        const store = new Store(':memory:')
        const db = (store as any).db as Database
        seedSession(db, 's1', 'ns1', '/p')
        for (let i = 0; i < 5; i++) {
            insertMsg(db, `m${i}`, 's1', `shared term number ${i}`, i + 1)
        }
        expect(searchMessages(db, 'ns1', '/p', 'shared', 3).length).toBe(3)
        store.close()
    })
})

function seedSession(
    db: Database,
    id: string,
    namespace: string,
    path: string,
    workspacePath?: string,
    worktreeBasePath?: string,
    name?: string,
    summary?: string,
    worktreeName?: string
): void {
    db.prepare('INSERT INTO sessions (id, namespace, created_at, updated_at, metadata) VALUES (?,?,?,?,?)')
        .run(id, namespace, 1, 1, JSON.stringify({
            path,
            ...(name ? { name } : {}),
            ...(summary ? { summary: { text: summary, updatedAt: 1 } } : {}),
            ...(workspacePath ? { workspacePath } : {}),
            ...(worktreeBasePath ? { worktree: { basePath: worktreeBasePath, name: worktreeName ?? 'worktree' } } : {})
        }))
}

function insertMsg(db: Database, id: string, sid: string, text: string, seq: number): void {
    db.prepare('INSERT INTO messages (id, session_id, content, created_at, seq) VALUES (?,?,?,?,?)')
        .run(id, sid, JSON.stringify({ role: 'user', content: text }), 1, seq)
}
