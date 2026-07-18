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

    const flush = (sid: string) => {
        const messageId = getAnchorMessageId()
        if (!messageId) return
        const body = {
            messageId,
            observedAt: Date.now(),
            expectedLastReadAt: lastKnownRef.current
        }
        const url = `/api/sessions/${encodeURIComponent(sid)}/read-position`
        const token = apiRef.current.token
        try {
            fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
                keepalive: true
            }).catch(() => { /* non-critical */ })
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
