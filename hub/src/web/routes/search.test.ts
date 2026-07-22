/**
 * Tests for GET /api/search (sibling-session content search, multi-agent-blackboard #3).
 *
 * Route-layer concerns only (store-level bm25/namespace isolation covered in
 * searchMessages.test.ts): namespace comes from auth not query, q/path required,
 * limit capped, FTS syntax errors swallowed to empty hits.
 */
import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function createApp(namespace: string = 'default') {
    const calls: Array<{ ns: string; path: string; q: string; limit: number }> = []
    const engine = {
        searchMessages: (ns: string, path: string, q: string, limit: number) => {
            calls.push({ ns, path, q, limit })
            return [{ messageId: 'm1', sessionId: 's1', seq: 1, createdAt: 1, path, rank: -1 }]
        },
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine))
    return { app, calls }
}

describe('GET /api/search (sibling-session search)', () => {
    it('passes namespace from auth (not query) to engine.searchMessages', async () => {
        const { app, calls } = createApp('ns1')
        const res = await app.request('/api/search?q=alpha&path=/p')
        expect(res.status).toBe(200)
        expect(calls.length).toBe(1)
        expect(calls[0].ns).toBe('ns1') // from auth, NOT a query param
        expect(calls[0].path).toBe('/p')
        expect(calls[0].q).toBe('alpha')
    })

    it('requires both q and path', async () => {
        const { app } = createApp()
        expect((await app.request('/api/search?path=/p')).status).toBe(400)
        expect((await app.request('/api/search?q=alpha')).status).toBe(400)
        expect((await app.request('/api/search')).status).toBe(400)
    })

    it('caps limit at 50', async () => {
        const { app, calls } = createApp()
        await app.request('/api/search?q=alpha&path=/p&limit=9999')
        expect(calls[0].limit).toBe(50)
    })

    it('returns hits as json', async () => {
        const { app } = createApp()
        const res = await app.request('/api/search?q=alpha&path=/p')
        const body = await res.json() as { hits: unknown[] }
        expect(Array.isArray(body.hits)).toBe(true)
        expect(body.hits.length).toBe(1)
    })

    it('swallows FTS syntax errors → empty hits, not 500', async () => {
        const engine = {
            searchMessages: () => { throw new Error('fts syntax') },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMessagesRoutes(() => engine))
        const res = await app.request('/api/search?q=***&path=/p')
        expect(res.status).toBe(200)
        const body = await res.json() as { hits: unknown[] }
        expect(body.hits).toEqual([])
    })
})
