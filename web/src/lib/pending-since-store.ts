/** Per-device pending-since timestamps for stable FAB ordering (no queue-jumping).
 *  Stores the first time a session was observed as pending; cleared when it leaves pending.
 *  Modeled on sessionLastSeen.ts (localStorage, per-session number). */

const STORAGE_KEY = 'hapi.pendingSince.v1'

function read(): Record<string, number> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) as Record<string, number> : {}
    } catch {
        return {}
    }
}

function write(data: Record<string, number>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
        // localStorage full or unavailable — non-critical, ordering degrades to createdAt fallback
    }
}

/** Get the current pending-since map. */
export function getPendingSinceStore(): Record<string, number> {
    return read()
}

/** Synchronously reconcile: for each pending session, record `now` if no entry;
 *  remove entries for sessions no longer pending. Must be called in the same
 *  render frame as the sort computation (prevents first-paint flash).
 *  Pure side-effect on localStorage; returns the updated store for convenience. */
export function reconcilePendingSessions(
    pendingSessionIds: string[],
    now: number = Date.now()
): Record<string, number> {
    const store = read()
    const pendingSet = new Set(pendingSessionIds)
    for (const id of pendingSessionIds) {
        if (!(id in store)) {
            store[id] = now
        }
    }
    for (const id of Object.keys(store)) {
        if (!pendingSet.has(id)) {
            delete store[id]
        }
    }
    write(store)
    return store
}

/** Sort comparator: pendingSince ascending; missing entries fall back to createdAt ascending. */
export function compareByPendingSince(
    a: { id: string; createdAt: number },
    b: { id: string; createdAt: number },
    store?: Record<string, number>
): number {
    const s = store ?? read()
    const aSince = s[a.id]
    const bSince = s[b.id]
    if (aSince !== undefined && bSince !== undefined) return aSince - bSince
    if (aSince !== undefined) return -1
    if (bSince !== undefined) return 1
    return a.createdAt - b.createdAt
}
