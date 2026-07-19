// v2: stores the per-device SEEN ATTENTION REVISION (integer), not an epoch-ms
// timestamp. The red-dot model (web-chat-read-position-sync §2.1) compares
// hub-side attentionRev/handledRev against this rev. The v1 key held epoch-ms
// updatedAt watermarks — incompatible units, so the key is bumped to make the
// cut explicit (a stale v1 ms value would otherwise read as a giant rev and
// suppress every red dot).
export const STORAGE_KEY = 'hapi.sessionLastSeen.v2'

// 同 tab 通知：markSessionSeen 派发此事件，useSessionLastSeenVersion 监听它
// （浏览器 `storage` 事件不在执行 setItem 的当前 tab 触发，故需同 tab 自通知）
export const SESSION_LAST_SEEN_EVENT = 'hapi:session-last-seen'

type LastSeenStore = Record<string, number>

let cachedRaw: string | null | undefined
let cachedStore: LastSeenStore = {}

function getLocalStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStore(): LastSeenStore {
    const storage = getLocalStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(STORAGE_KEY)
        if (raw === cachedRaw) {
            return cachedStore
        }
        cachedRaw = raw
        if (!raw) {
            cachedStore = {}
            return cachedStore
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            cachedStore = {}
            return cachedStore
        }
        cachedStore = parsed as LastSeenStore
        return cachedStore
    } catch {
        return {}
    }
}

function writeStore(store: LastSeenStore): void {
    const storage = getLocalStorage()
    if (!storage) {
        return
    }
    try {
        const raw = JSON.stringify(store)
        storage.setItem(STORAGE_KEY, raw)
        cachedRaw = raw
        cachedStore = store
    } catch {
        // Ignore storage errors
    }
}

/** Read this device's seen attention revision for a session (0 if never
 *  marked). Fed to classifySessionAttention as `localSeenRev`. */
export function getSessionLastSeenAt(sessionId: string): number {
    return readStore()[sessionId] ?? 0
}

export function getSessionLastSeenStore(): Readonly<LastSeenStore> {
    return readStore()
}

function notifySessionLastSeenChange(sessionId: string): void {
    if (typeof window === 'undefined') {
        return
    }
    window.dispatchEvent(new CustomEvent(SESSION_LAST_SEEN_EVENT, { detail: { sessionId } }))
}

/** Stamp this device's seen attention revision (规则 A 本端灭). Monotonic: only
 *  writes + notifies when the rev actually advances, so a no-op re-entry (e.g.
 *  re-clicking the open session) doesn't flap the red dot. */
export function markSessionSeen(sessionId: string, seenRev: number): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    const prev = store[sessionId] ?? 0
    if (seenRev > prev) {
        writeStore({ ...store, [sessionId]: seenRev })
        notifySessionLastSeenChange(sessionId)
    }
}
