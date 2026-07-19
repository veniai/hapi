import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    fetchLatestMessages,
    fetchLocatedWindow,
    fetchNewerMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    setAtBottom as setMessageWindowAtBottom,
    subscribeMessageWindow,
    type MessageWindowState,
} from '@/lib/message-window-store'
import { clearChatScrollPosition } from '@/lib/chat-scroll-store'

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    pending: [],
    pendingCount: 0,
    hasMore: false,
    hasNewer: false,
    oldestSeq: null,
    newestSeq: null,
    isLoading: false,
    hasLoadedLatest: false,
    isLoadingMore: false,
    warning: null,
    atBottom: true,
    messagesVersion: 0,
}

export function useMessages(api: ApiClient | null, sessionId: string | null): {
    messages: DecryptedMessage[]
    pendingMessages: DecryptedMessage[]
    warning: string | null
    isLoading: boolean
    hasLoadedLatest: boolean
    isLoadingMore: boolean
    hasMore: boolean
    pendingCount: number
    messagesVersion: number
    loadMore: () => Promise<unknown>
    refetch: () => Promise<unknown>
    flushPending: () => Promise<void>
    setAtBottom: (atBottom: boolean) => void
    /** True when the located window has messages beyond it (hasNewer) — the
     *  thread surfaces a "load newer" affordance that calls fetchNewer. */
    hasNewer: boolean
    /** Page forward from a located window toward the latest messages. */
    fetchNewer: () => Promise<void>
    /** Session-entry load. target != null → locate the window on that message
     *  (saved/hub read position); target == null → load latest (bottom). On
     *  locator not-found (target message gone) the saved anchor is cleared and
     *  we fall back to latest. Driven by SessionPage, not an auto effect, so
     *  the target can be picked from saved LWW hub read position. */
    loadInitial: (targetMessageId: string | null) => Promise<void>
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) {
                return () => {}
            }
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => {
            if (!sessionId) {
                return EMPTY_STATE
            }
            return getMessageWindowState(sessionId)
        }, [sessionId]),
        () => EMPTY_STATE
    )

    // No auto-fetch effect here: SessionPage drives the initial load via
    // loadInitial so it can locate the window on the saved/hub read position
    // instead of always landing at the bottom.

    const loadInitial = useCallback(async (targetMessageId: string | null) => {
        if (!api || !sessionId) return
        if (targetMessageId) {
            const result = await fetchLocatedWindow(api, sessionId, targetMessageId)
            if (!result.ok) {
                if (result.reason === 'not-found') {
                    // Target vanished (deleted / cross-device race). Drop the stale
                    // saved anchor before falling back.
                    clearChatScrollPosition(sessionId)
                }
                // not-found / failed: fall back to latest so the user isn't stuck
                // on an empty window + "Failed to locate" warning. busy: a load is
                // already in flight — let it land, don't double-fetch.
                if (result.reason !== 'busy') {
                    await fetchLatestMessages(api, sessionId)
                }
            }
            return
        }
        await fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    // 冻住落位 thrash：reload/进入 总 fetchLatest（落最新），saved/locator 落位停用。
    // read-position 临时停用（hub locator API + reporter 保留），等落位理顺再接回。
    useEffect(() => {
        if (!api || !sessionId) return
        void fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    const loadMore = useCallback(async () => {
        if (!api || !sessionId) return
        if (!state.hasMore || state.isLoadingMore) return
        await fetchOlderMessages(api, sessionId)
    }, [api, sessionId, state.hasMore, state.isLoadingMore])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    const flushPending = useCallback(async () => {
        if (!sessionId) return
        const needsRefresh = flushPendingMessages(sessionId)
        if (needsRefresh && api) {
            await fetchLatestMessages(api, sessionId)
        }
    }, [api, sessionId])

    const setAtBottom = useCallback((atBottom: boolean) => {
        if (!sessionId) return
        setMessageWindowAtBottom(sessionId, atBottom)
    }, [sessionId])

    const fetchNewer = useCallback(async () => {
        if (!api || !sessionId) return
        await fetchNewerMessages(api, sessionId)
    }, [api, sessionId])

    return {
        messages: state.messages,
        pendingMessages: state.pending,
        warning: state.warning,
        isLoading: state.isLoading,
        hasLoadedLatest: state.hasLoadedLatest,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        pendingCount: state.pendingCount,
        messagesVersion: state.messagesVersion,
        loadMore,
        refetch,
        flushPending,
        setAtBottom,
        loadInitial,
        hasNewer: state.hasNewer,
        fetchNewer,
    }
}
