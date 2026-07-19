import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

describe('cancelQueuedMessage', () => {
    it('happy path: deletes queued message, returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-happy')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-1')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-1')
        }

        // Row should be gone from uninvoked list
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    it('already-invoked: returns status=invoked with full message row, row stays in DB', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-already-invoked')
        const content = { role: 'user', content: { type: 'text', text: 'hello' } }
        const msg = store.messages.addMessage(session.id, content, 'lid-2')

        const invokedAt = Date.now()
        // Simulate CLI invoke ack
        store.messages.markMessagesInvoked(session.id, ['lid-2'], invokedAt)

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('invoked')

        // Must include the invoked row so the web client can restore authoritative state
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe('lid-2')
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists (with invoked_at set)
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })

    it('cancel × 2 idempotent: second call returns status=cancelled with localId=null (row gone)', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-idempotent')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-3')

        const first = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe('lid-3')
        }

        const second = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    it('non-existent messageId: returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-nonexistent')

        const result = store.messages.cancelQueuedMessage(session.id, 'nonexistent-id')
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }
    })

    it('wrong sessionId: returns status=cancelled with localId=null, message from other session untouched', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'cancel-session-a')
        const sessionB = makeSession(store, 'cancel-session-b')
        const msg = store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-A')

        const result = store.messages.cancelQueuedMessage(sessionB.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }

        // Original message still exists
        const remaining = store.messages.getUninvokedLocalMessages(sessionA.id)
        expect(remaining).toHaveLength(1)
    })

    it('cancelled localId is propagated from the deleted row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-localid-propagate')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-propagate')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-propagate')
        }
    })

    it('cancel by localId before server echo: localId match returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid')
        // Simulate the optimistic row: server has stored it with local_id but web client
        // still holds msg.id === localId (server echo not yet received).
        const localId = 'local:pre-echo-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        // The web client passes localId as messageId (before server echo replaces it)
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe(localId)
        }

        // Row should be gone
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    it('cancel by localId × 2 idempotent: second call returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-idempotent')
        const localId = 'local:idem-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const first = store.messages.cancelQueuedMessage(session.id, localId)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe(localId)
        }

        // Second cancel by the same localId — row is already gone
        const second = store.messages.cancelQueuedMessage(session.id, localId)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    it('cancel by localId when invoked: returns status=invoked with message row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-invoked')
        const localId = 'local:invoked-id'
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const invokedAt = Date.now()
        store.messages.markMessagesInvoked(session.id, [localId], invokedAt)

        // Web client passes localId as messageId — should detect invoked_at IS NOT NULL
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('invoked')
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe(localId)
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })
})

describe('addMessage: scheduledAt invariants', () => {
    it('rejects scheduledAt without a localId — would silently invoke immediately', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-invariant')
        const future = Date.now() + 60_000

        expect(() =>
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'orphan scheduled' } },
                undefined,
                future
            )
        ).toThrow(/scheduledAt requires a localId/)
    })

    it('accepts scheduledAt when paired with a localId and keeps invoked_at NULL', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-ok')
        const future = Date.now() + 60_000

        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued for later' } },
            'lid-sched',
            future
        )

        expect(msg.scheduledAt).toBe(future)
        expect(msg.invokedAt).toBeNull()
    })
})

describe('getDeliverableMessagesAfter: CLI backfill excludes future-scheduled rows', () => {
    it('omits rows whose scheduled_at > now (would otherwise be replayed early on reconnect)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-future-sched')
        const now = Date.now()
        const future = now + 60_000
        const past = now - 60_000

        const immediate = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'lid-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future-scheduled' } },
            'lid-future',
            future
        )
        const matureSched = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature-scheduled' } },
            'lid-mature',
            past
        )

        const delivered = store.messages.getDeliverableMessagesAfter(session.id, 0, now)
        const ids = delivered.map((m) => m.id)
        expect(ids).toContain(immediate.id)
        expect(ids).toContain(matureSched.id)
        expect(ids).not.toContain('lid-future')
        const localIds = delivered.map((m) => m.localId)
        expect(localIds).not.toContain('lid-future')
    })

    it('returns the row once now advances past scheduled_at (release boundary)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-release-boundary')
        const fireAt = Date.now() - 60_000

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'boundary' } },
            'lid-bnd',
            fireAt
        )

        const before = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt - 1)
        expect(before.find((m) => m.localId === 'lid-bnd')).toBeUndefined()

        const exact = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt)
        expect(exact.find((m) => m.localId === 'lid-bnd')).toBeDefined()
    })

    it('respects afterSeq alongside the scheduled_at filter (2-axis interaction)', () => {
        // Verifies the seq cursor and the scheduled-at filter compose correctly:
        // a row that satisfies one axis but fails the other must be excluded.
        const store = makeStore()
        const session = makeSession(store, 'backfill-2axis')
        const now = Date.now()

        const m1 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'first' } },
            'lid-1'
        )
        const m2 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'second' } },
            'lid-2'
        )

        // afterSeq = m1.seq → only m2 should be returned.
        const onlyM2 = store.messages.getDeliverableMessagesAfter(session.id, m1.seq, now)
        expect(onlyM2.map((m) => m.id)).toEqual([m2.id])

        // afterSeq = m2.seq → nothing (cursor at the end).
        const empty = store.messages.getDeliverableMessagesAfter(session.id, m2.seq, now)
        expect(empty).toHaveLength(0)
    })
})

describe('countFutureScheduledLocalMessages', () => {
    it('counts only future scheduled uninvoked local messages', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-count')
        const now = Date.now()

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate queued' } },
            'local-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future scheduled' } },
            'local-future',
            now + 60_000
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature scheduled' } },
            'local-mature',
            now - 1
        )

        expect(store.messages.countFutureScheduledLocalMessages(session.id, now)).toBe(1)
    })

    it('batch query returns counts keyed by session id', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'sched-batch-a')
        const sessionB = makeSession(store, 'sched-batch-b')
        const now = Date.now()

        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a1' } },
            'a-1',
            now + 60_000
        )
        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a2' } },
            'a-2',
            now + 120_000
        )
        store.messages.addMessage(
            sessionB.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'b-1'
        )

        const counts = store.messages.countFutureScheduledBySessionIds([sessionA.id, sessionB.id], now)
        expect(counts.get(sessionA.id)).toBe(2)
        expect(counts.get(sessionB.id)).toBeUndefined()

        const nextAt = store.messages.minFutureScheduledAtBySessionIds([sessionA.id, sessionB.id], now)
        expect(nextAt.get(sessionA.id)).toBe(now + 60_000)
        expect(nextAt.get(sessionB.id)).toBeUndefined()
    })
})

describe('getMessagesByPositionAfter', () => {
    it('returns messages strictly after the cursor (ascending), empty when cursor at the end', () => {
        const store = makeStore()
        const session = makeSession(store, 'after-cursor')
        const m1 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')
        const m2 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '2' } }, 'l2')
        const m3 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '3' } }, 'l3')

        const pos = (m: typeof m1) => ({ at: (m.invokedAt ?? m.createdAt) as number, seq: m.seq as number })

        expect(store.messages.getMessagesByPositionAfter(session.id, 50).map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])
        expect(store.messages.getMessagesByPositionAfter(session.id, 50, pos(m1)).map((m) => m.id)).toEqual([m2.id, m3.id])
        expect(store.messages.getMessagesByPositionAfter(session.id, 50, pos(m2)).map((m) => m.id)).toEqual([m3.id])
        expect(store.messages.getMessagesByPositionAfter(session.id, 50, pos(m3))).toEqual([])
    })

    it('clamps limit to the 1..200 band', () => {
        const store = makeStore()
        const session = makeSession(store, 'after-clamp')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')

        // limit 0 / huge should not throw and should still return rows.
        expect(store.messages.getMessagesByPositionAfter(session.id, 0).length).toBe(1)
        expect(store.messages.getMessagesByPositionAfter(session.id, 99999).length).toBe(1)
    })
})

describe('locateMessageWindow', () => {
    it('locates the target with older + newer cursors and inclusive window', () => {
        const store = makeStore()
        const session = makeSession(store, 'locate')
        const m1 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')
        const m2 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '2' } }, 'l2')
        const m3 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '3' } }, 'l3')

        const win = store.messages.locateMessageWindow(session.id, m2.id, { beforeLimit: 1, afterLimit: 1 })
        expect(win).not.toBeNull()
        expect(win!.target).toEqual({ at: (m2.invokedAt ?? m2.createdAt) as number, seq: m2.seq as number })
        expect(win!.messages.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])
        expect(win!.olderCursor).not.toBeNull()
        expect(win!.newerCursor).not.toBeNull()
        expect(win!.hasOlder).toBe(false)
        expect(win!.hasNewer).toBe(false)
    })

    it('returns null when the target message does not exist in the session', () => {
        const store = makeStore()
        const session = makeSession(store, 'locate-missing')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')

        const win = store.messages.locateMessageWindow(session.id, 'nonexistent-id', { beforeLimit: 50, afterLimit: 50 })
        expect(win).toBeNull()
    })

    it('returns null when the target id exists but belongs to another session', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'locate-xsession-a')
        const sessionB = makeSession(store, 'locate-xsession-b')
        const m = store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')

        const win = store.messages.locateMessageWindow(sessionB.id, m.id, { beforeLimit: 50, afterLimit: 50 })
        expect(win).toBeNull()
    })

    it('locates by web composite id by extracting the bare uuid', () => {
        const store = makeStore()
        const session = makeSession(store, 'locate-composite')
        const m = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '1' } }, 'l1')
        // Web composite forms: `${msg.id}:${idx}` and `kind:${msg.id}:${idx}`.
        const compositeA = `${m.id}:0`
        const compositeB = `agent-reasoning:${m.id}:0`

        const winA = store.messages.locateMessageWindow(session.id, compositeA, { beforeLimit: 50, afterLimit: 50 })
        const winB = store.messages.locateMessageWindow(session.id, compositeB, { beforeLimit: 50, afterLimit: 50 })

        const expectedTarget = { at: (m.invokedAt ?? m.createdAt) as number, seq: m.seq as number }
        expect(winA).not.toBeNull()
        expect(winA!.target).toEqual(expectedTarget)
        expect(winB).not.toBeNull()
        expect(winB!.target).toEqual(expectedTarget)
    })

    it('reports hasOlder/hasNewer when more messages lie beyond the limits', () => {
        const store = makeStore()
        const session = makeSession(store, 'locate-bounds')
        const msgs = Array.from({ length: 5 }, (_, i) =>
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: `${i}` } }, `l${i}`)
        )
        const mid = msgs[2]

        const win = store.messages.locateMessageWindow(session.id, mid.id, { beforeLimit: 1, afterLimit: 1 })
        expect(win).not.toBeNull()
        expect(win!.hasOlder).toBe(true)
        expect(win!.hasNewer).toBe(true)
        // Window still centered on target: 1 older + target + 1 newer.
        expect(win!.messages.map((m) => m.id)).toEqual([msgs[1].id, mid.id, msgs[3].id])
    })
})
