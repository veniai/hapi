export type PersistedChatScrollPosition = {
    scrollTop: number
    anchor: {
        id: string
        topOffset: number
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
        return {
            scrollTop: parsed.scrollTop,
            anchor: anchor
                && typeof anchor.id === 'string'
                && typeof anchor.topOffset === 'number'
                && Number.isFinite(anchor.topOffset)
                ? { id: anchor.id, topOffset: anchor.topOffset }
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
            anchor: position.anchor
                ? {
                    id: position.anchor.id,
                    topOffset: Math.round(position.anchor.topOffset)
                }
                : null
        }))
        sessionStorage.removeItem(`${LEGACY_STORAGE_KEY_PREFIX}${sessionId}`)
    } catch {
        // Position persistence is best-effort in private mode and under quota pressure.
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
