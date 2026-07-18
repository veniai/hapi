export type PersistedChatScrollPosition = {
    scrollTop: number
    // CapturedAt = local clock at the moment the anchor was written. Used by the
    // session-entry LWW pick (saved messageId@capturedAt vs hub
    // lastReadMessageId@lastReadAt) to decide which read position is newer when
    // entering a session. See doc/spec/web-chat-read-position-sync.md §4.5(g).
    capturedAt?: number
    anchor: {
        id: string
        topOffset: number
        messageId?: string
    } | null
}

const STORAGE_KEY_PREFIX = 'hapi.chat-scroll.v2.'
const LEGACY_STORAGE_KEY_PREFIX = 'hapi.chat-scroll.v1.'

function storageKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionId}`
}

function parsePosition(raw: string | null): PersistedChatScrollPosition | null {
    if (raw === null) return null
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedChatScrollPosition>
        if (typeof parsed.scrollTop !== 'number' || !Number.isFinite(parsed.scrollTop) || parsed.scrollTop < 0) {
            return null
        }
        const anchor = parsed.anchor
        const capturedAt = typeof parsed.capturedAt === 'number' && Number.isFinite(parsed.capturedAt)
            ? parsed.capturedAt
            : undefined
        return {
            scrollTop: parsed.scrollTop,
            capturedAt,
            anchor: anchor
                && typeof anchor.id === 'string'
                && typeof anchor.topOffset === 'number'
                && Number.isFinite(anchor.topOffset)
                ? {
                    id: anchor.id,
                    topOffset: anchor.topOffset,
                    // Preserve raw messageId for the locator target pick on
                    // session entry (§4.3). Previously dropped here, which left
                    // the cross-device restore path without a usable target.
                    messageId: typeof anchor.messageId === 'string' ? anchor.messageId : undefined
                }
                : null
        }
    } catch {
        return null
    }
}

export function readChatScrollPosition(sessionId: string): PersistedChatScrollPosition | null {
    try {
        const persisted = parsePosition(localStorage.getItem(storageKey(sessionId)))
        if (persisted) return persisted

        const legacyRaw = sessionStorage.getItem(`${LEGACY_STORAGE_KEY_PREFIX}${sessionId}`)
        const legacyScrollTop = legacyRaw === null ? NaN : Number(legacyRaw)
        if (!Number.isFinite(legacyScrollTop) || legacyScrollTop < 0) return null
        return { scrollTop: legacyScrollTop, anchor: null }
    } catch {
        return null
    }
}

export function writeChatScrollPosition(sessionId: string, position: PersistedChatScrollPosition): void {
    try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify({
            scrollTop: Math.max(0, Math.round(position.scrollTop)),
            // Stamp the local capture time so the session-entry LWW pick can
            // compare saved vs hub read positions (§4.5(g)).
            capturedAt: Date.now(),
            anchor: position.anchor
                ? {
                    id: position.anchor.id,
                    topOffset: Math.round(position.anchor.topOffset),
                    messageId: position.anchor.messageId
                }
                : null
        }))
        sessionStorage.removeItem(`${LEGACY_STORAGE_KEY_PREFIX}${sessionId}`)
    } catch {
        // Position persistence is best-effort in private mode and under quota pressure.
    }
}

export function clearChatScrollPosition(sessionId: string): void {
    try {
        localStorage.removeItem(storageKey(sessionId))
    } catch {
    }
}

export function gcChatScrollPositions(validSessionIds: Set<string>): number {
    let removed = 0
    try {
        const keysToRemove: string[] = []
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue
            if (!validSessionIds.has(key.slice(STORAGE_KEY_PREFIX.length))) {
                keysToRemove.push(key)
            }
        }
        for (const key of keysToRemove) {
            localStorage.removeItem(key)
            removed += 1
        }
    } catch {
    }
    return removed
}
