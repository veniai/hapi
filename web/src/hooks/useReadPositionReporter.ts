/** Reports the last-read message position to hub (low-frequency, unload-safe).
 *  Triggers: pagehide, visibilitychange→hidden, session switch (keyed cleanup).
 *  Uses fetch keepalive for unload-safety. Does NOT report on every scroll. */
import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'

interface ReadPositionReporterOptions {
    api: ApiClient
    sessionId: string | null
    /** Returns the current anchor messageId (raw, not DOM id) or null if none. */
    getAnchorMessageId: () => string | null
    /** Last-known hub lastReadAt (from GET /sessions or SSE). */
    lastKnownHubReadAt: number | null
}

export function useReadPositionReporter({
    api,
    sessionId,
    getAnchorMessageId,
    lastKnownHubReadAt
}: ReadPositionReporterOptions): void {
    const apiRef = useRef(api)
    apiRef.current = api
    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const lastKnownRef = useRef(lastKnownHubReadAt)
    lastKnownRef.current = lastKnownHubReadAt
    // Stable observedAt per messageId (§4.5(a)): reusing the same timestamp for
    // the same message avoids refreshing the hub revision on every flush, which
    // could overwrite a genuinely newer remote position.
    const lastAnchorRef = useRef<{ messageId: string; observedAt: number } | null>(null)

    const flush = (sid: string) => {
        const messageId = getAnchorMessageId()
        if (!messageId) return
        let observedAt: number
        if (lastAnchorRef.current?.messageId === messageId) {
            observedAt = lastAnchorRef.current.observedAt
        } else {
            observedAt = Date.now()
            lastAnchorRef.current = { messageId, observedAt }
        }
        const body = {
            messageId,
            observedAt,
            expectedLastReadAt: lastKnownRef.current
        }
        const url = `/api/sessions/${encodeURIComponent(sid)}/read-position`
        const token = apiRef.current.getBearerToken()
        try {
            fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
                keepalive: true
            })
                .then((resp) => resp.json())
                .then((data: { ok?: boolean; updatedAt?: number; stale?: boolean; currentUpdatedAt?: number | null }) => {
                    // Advance the local CAS revision with the hub's authoritative
                    // updatedAt so the next report carries it (breaks stale-write
                    // loops). Best-effort: on pagehide the page may unload before
                    // the response arrives — that's fine, lastKnownRef just stays.
                    if (typeof data.updatedAt === 'number') {
                        lastKnownRef.current = data.updatedAt
                    } else if (data.stale && typeof data.currentUpdatedAt === 'number') {
                        lastKnownRef.current = data.currentUpdatedAt
                    }
                })
                .catch(() => { /* non-critical */ })
        } catch {
            /* non-critical */
        }
    }

    useEffect(() => {
        if (!sessionId) return
        const onUnload = () => flush(sessionId)
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flush(sessionId)
        }
        document.addEventListener('pagehide', onUnload)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            document.removeEventListener('pagehide', onUnload)
            document.removeEventListener('visibilitychange', onVisibility)
            // Session switch cleanup — flush before unmount
            flush(sessionId)
        }
    }, [sessionId])
}
