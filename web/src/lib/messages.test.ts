import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        id: partial.id,
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }
}

describe('mergeMessages', () => {
    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })
})

describe('mergeMessages localId reconciliation (directional)', () => {
    // Direction is load-bearing: only a NON-optimistic server row in `incoming`
    // can displace an optimistic bubble in `existing`. selectQueuedMessages in
    // QueuedMessagesBar relies on this to dedup across the messages/pending
    // buckets — it always calls mergeMessages(messages, pending) with the
    // optimistic copy as `existing`.
    it('drops the optimistic bubble when its server echo arrives in incoming', () => {
        const optimistic = userMessage({ id: 'local-1', status: 'queued' })
        const echo = userMessage({ id: 'server-1', localId: 'local-1', status: 'queued' })

        const merged = mergeMessages([optimistic], [echo])

        expect(merged).toHaveLength(1)
        expect(merged[0]?.id).toBe('server-1')
    })

    it('does NOT displace an existing server row when the optimistic copy is in incoming', () => {
        // Documents the directionality boundary: passing the optimistic copy as
        // `incoming` leaves BOTH copies — so callers must keep the optimistic
        // copy as `existing`. If this ever changes, selectQueuedMessages'
        // cross-bucket dedup breaks silently.
        const echo = userMessage({ id: 'server-1', localId: 'local-1', status: 'queued' })
        const optimistic = userMessage({ id: 'local-1', status: 'queued' })

        const merged = mergeMessages([echo], [optimistic])

        expect(merged.map((m) => m.id).sort()).toEqual(['local-1', 'server-1'])
    })
})
