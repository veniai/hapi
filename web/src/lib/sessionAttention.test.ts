import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { classifySessionAttention, classifyAttentionKind, isAttentionLit, shouldMarkSessionEntry } from './sessionAttention'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 1000,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        lastReadMessageId: null,
        lastReadAt: null,
        attentionRev: 0,
        handledRev: 0,
        ...overrides
    }
}

describe('classifySessionAttention — rev model (§2.1/§3.1)', () => {
    it('permission lights when attentionRev is ahead of seen+handled', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', attentionRev: 3, pendingRequestKinds: ['permission'] }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('returns null for archived sessions even when stale requests + rev remain', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'archived',
                active: false,
                attentionRev: 5,
                metadata: { path: '/work/hapi', lifecycleState: 'archived' },
                pendingRequestKinds: ['permission']
            }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toBeNull()
    })

    it('prioritizes permission over unread activity', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', attentionRev: 3, pendingRequestKinds: ['permission'] }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('unread lights when attentionRev > max(seen, handled)', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', attentionRev: 3 }),
            { localSeenRev: 1, handledRev: 2 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('background kind shows for active sessions with running background tasks', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', attentionRev: 1, backgroundTaskCount: 2 }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'background' })
    })

    it('inactive session with new attention still lights as unread', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', active: false, attentionRev: 3 }),
            { localSeenRev: 1, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('surfaces input request even while thinking', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', thinking: true, attentionRev: 2, pendingRequestKinds: ['input'] }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'input' })
    })

    it('surfaces permission request even while thinking', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', thinking: true, attentionRev: 2, pendingRequestKinds: ['permission'] }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('suppresses unread/background for thinking sessions without pending requests', () => {
        // attentionRev is ahead, but thinking nulls the kind → no dot.
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', thinking: true, attentionRev: 5, backgroundTaskCount: 2 }),
            { localSeenRev: 0, handledRev: 0 }
        )
        expect(attention).toBeNull()
    })
})

describe('red-dot state machine (§3.1.3–§3.1.6, §9.1)', () => {
    const litSummary = makeSummary({ id: 'x', attentionRev: 5 })

    it('§3.1.2 current/selected session still lights (no selected suppression)', () => {
        // The model has no `selected` parameter; the dot lights purely on rev.
        const attention = classifySessionAttention(litSummary, { localSeenRev: 0, handledRev: 0 })
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('§3.1.3 click clears LOCAL only — advancing localSeenRev hides the dot here', () => {
        // Device A clicks → localSeenRev catches up to attentionRev → not lit on A.
        const afterClick = classifySessionAttention(litSummary, { localSeenRev: 5, handledRev: 0 })
        expect(afterClick).toBeNull()
    })

    it('§3.1.3 click on device A does NOT clear device B (B still lit)', () => {
        // Device B has not clicked — its localSeenRev is still 0.
        const onB = classifySessionAttention(litSummary, { localSeenRev: 0, handledRev: 0 })
        expect(onB).toEqual({ kind: 'unread' })
    })

    it('§3.1.4 send clears BOTH devices — handledRev catches up to attentionRev', () => {
        // After a successful send on any device, hub advances handledRev → 5.
        const onA = classifySessionAttention(litSummary, { localSeenRev: 0, handledRev: 5 })
        const onB = classifySessionAttention(litSummary, { localSeenRev: 3, handledRev: 5 })
        expect(onA).toBeNull()
        expect(onB).toBeNull()
    })

    it('§3.1.5 send failure does NOT clear — handledRev unchanged stays lit', () => {
        // Failed send does not advance handledRev; the dot persists.
        const attention = classifySessionAttention(litSummary, { localSeenRev: 0, handledRev: 0 })
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('§3.1.6 concurrency: send then NEW result re-lights both devices', () => {
        // Send advances handledRev to 5; then a new agent result bumps
        // attentionRev to 6 → 6 > max(seen, 5) lights again.
        const afterNewResult = makeSummary({ id: 'x', attentionRev: 6 })
        const onA = classifySessionAttention(afterNewResult, { localSeenRev: 5, handledRev: 5 })
        const onB = classifySessionAttention(afterNewResult, { localSeenRev: 0, handledRev: 5 })
        expect(onA).toEqual({ kind: 'unread' })
        expect(onB).toEqual({ kind: 'unread' })
    })

    it('defends against undefined rev fields (pre-migration / stale cache) → not lit', () => {
        const stale = makeSummary({ id: 'x' }) as unknown as SessionSummary
        delete (stale as Partial<SessionSummary>).attentionRev
        delete (stale as Partial<SessionSummary>).handledRev
        expect(isAttentionLit(stale, { localSeenRev: 0, handledRev: 0 })).toBe(false)
        expect(classifySessionAttention(stale, { localSeenRev: 0, handledRev: 0 })).toBeNull()
    })
})

describe('classifyAttentionKind (pure state)', () => {
    it('returns null for archived', () => {
        expect(classifyAttentionKind(makeSummary({ id: 'a', metadata: { path: '', lifecycleState: 'archived' } }))).toBeNull()
    })
    it('returns null while thinking with no pending request', () => {
        expect(classifyAttentionKind(makeSummary({ id: 'a', thinking: true }))).toBeNull()
    })
    it('returns unread by default', () => {
        expect(classifyAttentionKind(makeSummary({ id: 'a' }))).toBe('unread')
    })
})

describe('shouldMarkSessionEntry', () => {
    it('marks once per actual route entry, not on selected-session updates', () => {
        expect(shouldMarkSessionEntry({
            selectedSessionId: 'a', markedSessionId: null, sessionLoaded: true, tabVisible: true
        })).toBe(true)
        expect(shouldMarkSessionEntry({
            selectedSessionId: 'a', markedSessionId: 'a', sessionLoaded: true, tabVisible: true
        })).toBe(false)
        expect(shouldMarkSessionEntry({
            selectedSessionId: 'b', markedSessionId: 'a', sessionLoaded: true, tabVisible: true
        })).toBe(true)
    })

    it('waits for session data and a visible tab', () => {
        expect(shouldMarkSessionEntry({
            selectedSessionId: 'a', markedSessionId: null, sessionLoaded: false, tabVisible: true
        })).toBe(false)
        expect(shouldMarkSessionEntry({
            selectedSessionId: 'a', markedSessionId: null, sessionLoaded: true, tabVisible: false
        })).toBe(false)
    })
})
