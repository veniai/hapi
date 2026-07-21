import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    fetchLatestMessages,
    fetchNewerMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    setAtBottom as setMessageWindowAtBottom,
    subscribeMessageWindow,
    type MessageWindowState,
} from '@/lib/message-window-store'

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

    // 进入 session 总 fetchLatest（落最新）；阅读位置恢复由 TanStack Router
    // scrollRestoration 负责（见 doc/spec/web-chat-read-position-cleanup.md）。
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
        hasNewer: state.hasNewer,
        fetchNewer,
    }
}
