import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => { events.push(event) }
    } as unknown as EventPublisher
}

function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, createPublisher(events))
    const session = cache.getOrCreateSession(
        'attn-test',
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        'default'
    )
    return { store, events, cache, session }
}

/** Wire registerSessionHandlers with onAttentionBump → cache.bumpAttention, the
 *  same wiring startHub uses. Returns a handle to emit socket events. */
function registerAttnHandlers(
    store: Store,
    cache: SessionCache,
    sessionId: string
): { emitMessage: (content: unknown, localId?: string) => void; emitUpdateState: (agentState: unknown, expectedVersion: number) => void } {
    const handlers = new Map<string, (payload: unknown, cb?: unknown) => void>()
    registerSessionHandlers({
        on: (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler) },
        to: () => ({ emit() {} })
    } as never, {
        store,
        resolveSessionAccess: (sid) => {
            const stored = store.sessions.getSessionByNamespace(sid, 'default')
            return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
        },
        emitAccessError: () => {},
        onSessionActivity: () => {},
        onAttentionBump: (sid) => { cache.bumpAttention(sid) }
    })
    return {
        emitMessage: (content: unknown, localId?: string) => {
            handlers.get('message')?.({
                sid: sessionId,
                message: typeof content === 'string' ? content : JSON.stringify(content),
                localId
            })
        },
        emitUpdateState: (agentState: unknown, expectedVersion: number) => {
            handlers.get('update-state')?.({ sid: sessionId, agentState, expectedVersion }, () => {})
        }
    }
}

const agentReady = {
    role: 'agent',
    content: { type: 'event', data: { type: 'ready' } }
}

const userText = {
    role: 'user',
    content: { type: 'text', text: 'hello there' }
}

describe('attention revision — hub (web-chat-read-position-sync §2.1/§3.1/§4.1)', () => {
    it('an agent ready event bumps attentionRev and broadcasts it', () => {
        const { store, cache, session, events } = setup()
        const { emitMessage } = registerAttnHandlers(store, cache, session.id)

        emitMessage(agentReady)

        expect(cache.getSession(session.id)?.attentionRev).toBe(1)
        const patch = events.find((e): e is Extract<SyncEvent, { type: 'session-updated' }> =>
            e.type === 'session-updated'
            && typeof (e.data as { attentionRev?: number } | undefined)?.attentionRev === 'number')
        expect((patch?.data as { attentionRev?: number } | undefined)?.attentionRev).toBe(1)
    })

    it('user text does NOT bump attention (§4.1 excludes user sends)', () => {
        const { store, cache, session, events } = setup()
        const { emitMessage } = registerAttnHandlers(store, cache, session.id)

        emitMessage(userText)

        expect(cache.getSession(session.id)?.attentionRev).toBe(0)
        expect(events.some((e) => e.type === 'session-updated'
            && typeof (e.data as { attentionRev?: number } | undefined)?.attentionRev === 'number')
        ).toBe(false)
    })

    it('a permission request appearing bumps attentionRev (update-state)', () => {
        const { store, cache, session } = setup()
        const { emitUpdateState } = registerAttnHandlers(store, cache, session.id)

        // No requests before → requests after → empty→non-empty transition.
        emitUpdateState({
            requests: { 'req-1': { tool: 'Bash', createdAt: 1 } }
        }, 1)

        expect(cache.getSession(session.id)?.attentionRev).toBe(1)
    })

    it('resolving a request (non-empty→non-empty) does not double-bump', () => {
        const { store, cache, session } = setup()
        const { emitUpdateState } = registerAttnHandlers(store, cache, session.id)

        emitUpdateState({ requests: { 'req-1': { tool: 'Bash' } } }, 1)
        // Second update still has a request (not an empty→non-empty transition).
        emitUpdateState({ requests: { 'req-2': { tool: 'Edit' } } }, 2)

        expect(cache.getSession(session.id)?.attentionRev).toBe(1)
    })

    it('a background task starting (0→N) bumps attentionRev', () => {
        const { cache, session } = setup()
        cache.applyBackgroundTaskDelta(session.id, { started: 1, completed: 0 })
        expect(cache.getSession(session.id)?.attentionRev).toBe(1)
    })

    it('send advances handledRev to attentionRev (§3.1.4 — clears all devices)', () => {
        const { cache, session } = setup()
        cache.bumpAttention(session.id)   // attentionRev = 1
        const result = cache.advanceHandled(session.id)
        const s = cache.getSession(session.id)!
        expect(result?.changed).toBe(true)
        expect(s.handledRev).toBe(1)
        expect(s.attentionRev).toBe(s.handledRev) // invariant: equal → not lit
    })

    it('advanceHandled is idempotent when already caught up (no spurious clear)', () => {
        const { cache, session } = setup()
        cache.bumpAttention(session.id)
        cache.advanceHandled(session.id)
        const second = cache.advanceHandled(session.id)
        expect(second?.changed).toBe(false)
    })

    it('new attention after a send re-lights (attentionRev > handledRev, §3.1.6)', () => {
        const { cache, session } = setup()
        cache.bumpAttention(session.id)   // 1
        cache.advanceHandled(session.id)  // handled = 1
        cache.bumpAttention(session.id)   // attention = 2
        const s = cache.getSession(session.id)!
        expect(s.attentionRev ?? 0).toBe(2)
        expect(s.handledRev ?? 0).toBe(1)
        expect((s.attentionRev ?? 0)).toBeGreaterThan(s.handledRev ?? 0) // lit again
    })

    it('bump/advance are persisted to the store (survive refresh)', () => {
        const { store, cache, session } = setup()
        cache.bumpAttention(session.id)
        cache.advanceHandled(session.id)
        cache.bumpAttention(session.id)

        const stored = store.sessions.getSession(session.id)!
        expect(stored.attentionRev).toBe(2)
        expect(stored.handledRev).toBe(1)
    })

    it('records the unread-start message id when bump carries one (§2.3)', () => {
        const { cache, session } = setup()
        cache.bumpAttention(session.id, { messageId: 'msg-ready-1' })
        expect(cache.getSession(session.id)?.lastAttentionMessageId).toBe('msg-ready-1')
        // A later bump without a messageId does not clobber the prior hint.
        cache.bumpAttention(session.id)
        expect(cache.getSession(session.id)?.lastAttentionMessageId).toBe('msg-ready-1')
        // refreshSession preserves the cache-only hint (it is not stored).
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)?.lastAttentionMessageId).toBe('msg-ready-1')
    })
})
