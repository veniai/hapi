/** Session-entry target pick (web-chat-read-position-sync §5.1).
 *
 *  One session entry selects exactly one target, by priority:
 *    1. LWW winner of the local saved anchor vs the hub shared anchor.
 *    2. If neither anchor is usable but the session has unread attention, the
 *       hub's last-attention message (unread start, §2.3).
 *    3. null → the caller loads latest (only valid when there is also no
 *       unread attention — first-ever visit, §2.3 final clause).
 *
 *  Extracted as a pure function so the LWW / unread-start matrix is unit-
 *  testable without a React render harness. */

export type EntryTargetSource = 'saved' | 'hub' | 'unread'

export type EntryTarget = { target: string | null; source: EntryTargetSource | null }

export function isOptimisticEntryTarget(target: string): boolean {
    return target.split(':').some((part) => part.startsWith('__optimistic__'))
}

export function shouldMarkSessionEntry(input: {
    selectedSessionId: string | null
    markedSessionId: string | null
    sessionLoaded: boolean
    tabVisible: boolean
}): boolean {
    return input.selectedSessionId !== null
        && input.sessionLoaded
        && input.tabVisible
        && input.markedSessionId !== input.selectedSessionId
}

export type PickEntryTargetInput = {
    savedMessageId: string | null
    /** Local clock at which the saved anchor was captured. -Infinity / undefined
     *  when there is no saved anchor (or it lacks a timestamp). */
    savedCapturedAt?: number
    hubMessageId: string | null
    /** Hub-side observedAt for the shared read anchor. -Infinity / undefined when
     *  the hub has no read position. */
    hubLastReadAt?: number
    /** True when the session has unread attention (attentionRev > max(seen, handled)). */
    hasUnreadAttention: boolean
    /** Hub's last-attention message id (the unread-start hint), or null. */
    unreadStartMessageId: string | null
}

const NEG_INF = -Infinity

function ts(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : NEG_INF
}

export function pickEntryTarget(input: PickEntryTargetInput): EntryTarget {
    const savedAvailable = !!input.savedMessageId
    const hubAvailable = !!input.hubMessageId

    if (savedAvailable && hubAvailable) {
        // §5.1.1 LWW by timestamp; tie / undated → saved (local default; on
        // reload the reporter just flushed saved, so saved is at least as new).
        return ts(input.savedCapturedAt) >= ts(input.hubLastReadAt)
            ? { target: input.savedMessageId, source: 'saved' }
            : { target: input.hubMessageId, source: 'hub' }
    }
    if (savedAvailable) {
        return { target: input.savedMessageId, source: 'saved' }
    }
    if (hubAvailable) {
        return { target: input.hubMessageId, source: 'hub' }
    }

    // §2.3: no read anchor + unread attention → unread start (never latest).
    if (input.hasUnreadAttention && input.unreadStartMessageId) {
        return { target: input.unreadStartMessageId, source: 'unread' }
    }

    // §2.3 final clause: no anchor, no unread → latest.
    return { target: null, source: null }
}
