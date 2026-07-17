export const STORAGE_KEY = 'hapi.sessionLastSeen.v1'

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

export function markSessionSeen(sessionId: string, seenAt: number): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    const prev = store[sessionId] ?? 0
    // 仅当水位实际上升时才写 + 通知（单调；避免无变化触发同/跨 tab 抖动）
    if (seenAt > prev) {
        writeStore({ ...store, [sessionId]: seenAt })
        notifySessionLastSeenChange(sessionId)
    }
}
