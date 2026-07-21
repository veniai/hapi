import { describe, expect, it } from 'vitest'
import type { SessionPatch, SessionSummary } from '@/types/api'
import { applySessionSummaryPatch } from './session-summary-patch'
import { classifySessionAttention } from './sessionAttention'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true, thinking: false, activeAt: 0, createdAt: 0, updatedAt: 1000,
        metadata: null, todoProgress: null, pendingRequestsCount: 0,
        pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
        attentionRev: 0, handledRev: 0,
        ...overrides
    }
}

describe('applySessionSummaryPatch — §2.1 rev merge', () => {
    it('patches attentionRev and leaves handledRev cached', () => {
        const next = applySessionSummaryPatch(makeSummary({ id: 'a', handledRev: 2 }), { attentionRev: 5 } as SessionPatch)
        expect(next.attentionRev).toBe(5)
        expect(next.handledRev).toBe(2)
    })

    it('patches handledRev (send-clears-both) and leaves attentionRev cached', () => {
        const next = applySessionSummaryPatch(makeSummary({ id: 'a', attentionRev: 5 }), { handledRev: 5 } as SessionPatch)
        expect(next.handledRev).toBe(5)
        expect(next.attentionRev).toBe(5)
    })

    it('explicit attentionRev: 0 overrides cached (0 is not nullish)', () => {
        const next = applySessionSummaryPatch(makeSummary({ id: 'a', attentionRev: 9 }), { attentionRev: 0 } as SessionPatch)
        expect(next.attentionRev).toBe(0)
    })

    it('falls back to 0 when both patch and cached lack the field', () => {
        const stale = makeSummary({ id: 'a' })
        delete (stale as Partial<SessionSummary>).attentionRev
        delete (stale as Partial<SessionSummary>).handledRev
        const next = applySessionSummaryPatch(stale, { updatedAt: 2000 } as SessionPatch)
        expect(next.attentionRev).toBe(0)
        expect(next.handledRev).toBe(0)
    })

    it('keeps cached backgroundTaskCount when the key is absent', () => {
        const next = applySessionSummaryPatch(makeSummary({ id: 'a', backgroundTaskCount: 3 }), { attentionRev: 1 } as SessionPatch)
        expect(next.backgroundTaskCount).toBe(3)
    })
})

describe('SSE → summary → red-dot chain (§3.1.4 wired end-to-end at logic level)', () => {
    it('a session-updated {handledRev} patch clears the dot (send reached all devices)', () => {
        // Session lit: attentionRev 5 > max(seen 0, handled 0).
        const lit = makeSummary({ id: 'x', attentionRev: 5, handledRev: 0 })
        expect(classifySessionAttention(lit, { localSeenRev: 0, handledRev: 0 })).not.toBeNull()

        // Hub broadcasts handledRev = 5 after a send on any device.
        const afterSend = applySessionSummaryPatch(lit, { handledRev: 5 } as SessionPatch)
        // Same device (seen 0): handled now 5 → not lit.
        expect(classifySessionAttention(afterSend, { localSeenRev: 0, handledRev: afterSend.handledRev })).toBeNull()
    })

    it('a session-updated {attentionRev} patch lights the dot (new agent result)', () => {
        const quiet = makeSummary({ id: 'x', attentionRev: 0, handledRev: 0 })
        expect(classifySessionAttention(quiet, { localSeenRev: 0, handledRev: 0 })).toBeNull()

        const afterResult = applySessionSummaryPatch(quiet, { attentionRev: 4 } as SessionPatch)
        expect(classifySessionAttention(afterResult, { localSeenRev: 0, handledRev: 0 })).toEqual({ kind: 'unread' })
    })
})
