import { describe, expect, it } from 'vitest'
import { isOptimisticEntryTarget, pickEntryTarget, shouldMarkSessionEntry } from './read-position-target'

describe('isOptimisticEntryTarget', () => {
    it('recognizes raw and composite optimistic message ids', () => {
        expect(isOptimisticEntryTarget('__optimistic__abc')).toBe(true)
        expect(isOptimisticEntryTarget('user-text:__optimistic__abc')).toBe(true)
        expect(isOptimisticEntryTarget('user-text:durable-id')).toBe(false)
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

describe('pickEntryTarget — §5.1 LWW + §2.3 unread-start', () => {
    it('keeps the exact local offset when hub reports the same message later', () => {
        expect(pickEntryTarget({
            savedMessageId: 'agent-text:same:0', savedCapturedAt: 100,
            hubMessageId: 'agent-text:same:0', hubLastReadAt: 200,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'agent-text:same:0', source: 'saved' })
    })

    it('prefers the newer of saved vs hub (LWW)', () => {
        // saved newer than hub → saved
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: 200,
            hubMessageId: 'b', hubLastReadAt: 100,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'a', source: 'saved' })

        // hub newer than saved → hub (cross-device: stale local saved)
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: 100,
            hubMessageId: 'b', hubLastReadAt: 200,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'b', source: 'hub' })
    })

    it('tie favors saved (reload: reporter just flushed saved, hub ≈ same)', () => {
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: 200,
            hubMessageId: 'b', hubLastReadAt: 200,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'a', source: 'saved' })
    })

    it('falls back to hub when there is no saved anchor', () => {
        expect(pickEntryTarget({
            savedMessageId: null,
            hubMessageId: 'b', hubLastReadAt: 100,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'b', source: 'hub' })
    })

    it('falls back to saved when there is no hub anchor', () => {
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: 100,
            hubMessageId: null,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'a', source: 'saved' })
    })

    it('§2.3: no anchor + unread attention → unread-start (not latest)', () => {
        expect(pickEntryTarget({
            savedMessageId: null,
            hubMessageId: null,
            hasUnreadAttention: true, unreadStartMessageId: 'attn-msg'
        })).toEqual({ target: 'attn-msg', source: 'unread' })
    })

    it('§2.3: unread-start is NOT chosen when a read anchor exists (anchor wins)', () => {
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: 100,
            hubMessageId: null,
            hasUnreadAttention: true, unreadStartMessageId: 'attn-msg'
        })).toEqual({ target: 'a', source: 'saved' })
    })

    it('§2.3 final clause: no anchor + no unread → latest (null)', () => {
        expect(pickEntryTarget({
            savedMessageId: null,
            hubMessageId: null,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: null, source: null })
    })

    it('does not jump to unread-start when attention exists but no hint message', () => {
        // hasUnreadAttention but unreadStartMessageId null → latest (can't locate nothing).
        expect(pickEntryTarget({
            savedMessageId: null,
            hubMessageId: null,
            hasUnreadAttention: true, unreadStartMessageId: null
        })).toEqual({ target: null, source: null })
    })

    it('uses a saved anchor even without capturedAt when hub is absent (legacy saved)', () => {
        // Old saved positions predate the capturedAt field; they should still
        // restore when there is no hub anchor to compare against.
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: undefined,
            hubMessageId: null,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'a', source: 'saved' })
    })

    it('when both anchors are undated, prefers saved (local default)', () => {
        expect(pickEntryTarget({
            savedMessageId: 'a', savedCapturedAt: undefined,
            hubMessageId: 'b', hubLastReadAt: undefined,
            hasUnreadAttention: false, unreadStartMessageId: null
        })).toEqual({ target: 'a', source: 'saved' })
    })
})
