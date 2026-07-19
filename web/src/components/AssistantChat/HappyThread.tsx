import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useReadPositionReporter } from '@/hooks/useReadPositionReporter'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'
import {
    readChatScrollPosition,
    writeChatScrollPosition,
    type PersistedChatScrollPosition
} from '@/lib/chat-scroll-store'

type ScrollAnchor = {
    id: string
    topOffset: number
    messageId?: string
}

type PendingScrollRestore = {
    anchor: ScrollAnchor | null
    scrollTop: number
    scrollHeight: number
}

const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 120
const MANUAL_SCROLL_EPSILON_PX = 1
const SEND_SCROLL_TIMEOUT_MS = 1500
const BOTTOM_SCROLL_TIMEOUT_MS = 5000
const SCROLL_PERSIST_DELAY_MS = 150

type ScrollIntent = {
    distanceFromBottom: number
    isNearBottom: boolean
    isScrollingUp: boolean
}

type LocateOutlineTargetOptions = {
    targetMessageId: string
    findTarget: (anchorId: string) => HTMLElement | null
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
    thresholdPx?: number
}): ScrollIntent {
    const thresholdPx = params.thresholdPx ?? AUTO_SCROLL_RESUME_THRESHOLD_PX
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isNearBottom: distanceFromBottom < thresholdPx,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX
    }
}

export function resolveSavedScrollPosition(
    savedScrollTop: number,
    maxScrollTop: number,
    canFinalizeBelowTarget: boolean
): { scrollTop: number; pendingScrollTop: number | null } {
    const scrollTop = Math.min(savedScrollTop, Math.max(0, maxScrollTop))
    const restored = savedScrollTop === 0 || maxScrollTop >= savedScrollTop || canFinalizeBelowTarget
    return {
        scrollTop,
        pendingScrollTop: restored ? null : savedScrollTop
    }
}

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
            // Parse raw messageId from DOM id (hapi-message-${id}) for cross-device sync
            const messageId = message.id.startsWith('hapi-message-')
                ? message.id.slice('hapi-message-'.length)
                : message.id
            // Skip optimistic (not-yet-confirmed) messages — their id is temporary
            // and isn't a durable scroll/locate target.
            if (messageId.startsWith('__optimistic__')) continue
            return {
                id: message.id,
                topOffset: rect.top - viewportRect.top,
                messageId
            }
        }
    }
    return null
}

/** Capture the first FULLY-VISIBLE AGENT message id for read-position reporting
 *  (§4.5(a) M11: "首条完全可见的 agent 消息"). Returns null when no agent message
 *  is fully in view — the reporter then keeps the previous anchor (no spurious
 *  update from user/system or partially-visible messages). Distinct from
 *  captureScrollAnchor, which accepts any partially-visible message for saved
 *  scroll restoration. */
export function captureReadPositionAnchor(viewport: HTMLElement): string | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    for (const message of messages) {
        if (message.dataset.hapiRole !== 'agent') continue
        const rect = message.getBoundingClientRect()
        if (rect.top >= viewportRect.top && rect.bottom <= viewportRect.bottom) {
            const id = message.id.startsWith('hapi-message-')
                ? message.id.slice('hapi-message-'.length)
                : message.id
            // Skip optimistic ids — they aren't in the hub DB; reporting one would
            // make the next entry's locator 404 and lose the read position.
            if (id.startsWith('__optimistic__')) continue
            return id
        }
    }
    return null
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = document.getElementById(anchor.id)
    if (!target || !viewport.contains(target)) {
        return false
    }
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    viewport.scrollTop += targetRect.top - viewportRect.top - anchor.topOffset
    return true
}

export async function locateOutlineTargetMessage(options: LocateOutlineTargetOptions): Promise<HTMLElement | null> {
    const anchorId = getConversationMessageAnchorId(options.targetMessageId)
    let target = options.findTarget(anchorId)
    while (!target && options.hasMoreMessages()) {
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) {
            break
        }
        target = options.findTarget(anchorId)
    }
    return target
}

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    const { t } = useTranslation()
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {t('misc.newMessage', { n: props.count })} &#8595;
        </button>
    )
}

function LoadNewerIndicator(props: { loading: boolean; onClick: () => void }) {
    const { t } = useTranslation()
    return (
        <button
            onClick={props.onClick}
            disabled={props.loading}
            className="absolute bottom-32 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10 disabled:opacity-60"
        >
            {props.loading ? (
                <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" label={null} className="text-current" />
                    {t('misc.loading')}
                </span>
            ) : (
                <span className="inline-flex items-center gap-1">
                    <span aria-hidden="true">&darr;</span>
                    {t('misc.loadNewer')}
                </span>
            )}
        </button>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function ConversationOutlinePanel(props: {
    title: string
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
}) {
    const { t } = useTranslation()

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col border-l border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            aria-label={t('session.outline.title')}
        >
            <div className="flex items-start gap-3 border-b border-[var(--app-border)] p-3">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{t('session.outline.title')}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">{props.title}</div>
                </div>
                <button
                    type="button"
                    onClick={props.onClose}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('button.close')}
                    title={t('button.close')}
                >
                    <CloseIcon className="h-4 w-4" />
                </button>
            </div>

            {props.hasMoreMessages ? (
                <div className="border-b border-[var(--app-border)] p-3">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={props.onLoadMore}
                        disabled={props.isLoadingMoreMessages}
                        aria-busy={props.isLoadingMoreMessages}
                        className="w-full gap-1.5 text-xs"
                    >
                        {props.isLoadingMoreMessages ? (
                            <>
                                <Spinner size="sm" label={null} className="text-current" />
                                {t('misc.loading')}
                            </>
                        ) : (
                            <>
                                <span aria-hidden="true">↑</span>
                                {t('session.outline.loadOlder')}
                            </>
                        )}
                    </Button>
                </div>
            ) : null}

            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {props.items.map((item) => {
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[11px] font-medium uppercase text-[var(--app-hint)]">
                                            {t('session.outline.kind.user')}
                                        </span>
                                        <span className="line-clamp-2 text-sm leading-snug text-[var(--app-fg)]">
                                            {item.label}
                                        </span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onFlushPending: () => Promise<void> | void
    onAtBottomChange: (atBottom: boolean) => void
    isLoadingMessages: boolean
    hasLoadedMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    pendingCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    forceScrollToken: number
    outlineOpen: boolean
    outlineTitle: string
    outlineItems: readonly ConversationOutlineItem[]
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    findLatestUserMessageId: () => string | null
    sendScrollPreviousMessageId: string | null
    /** Hub-side lastReadAt (from session detail / SSE), fed to the read-position
     *  reporter as expectedLastReadAt for the LWW CAS (§4.5(f)). */
    hubLastReadAt: number | null
    /** Initial read-position target (LWW winner of saved vs hub). When set,
     *  the viewport scrolls to this message on entry instead of restoring
     *  saved/bottom — the core fix for §4.3 "落 target". null = no target
     *  (first-ever visit → bottom; or saved-only restore). */
    locatorTargetMessageId: string | null
    /** Located window has messages beyond it — show a "load newer" affordance. */
    hasNewer: boolean
    /** Page forward from the located window toward the latest messages. */
    onFetchNewer: () => Promise<void>
}) {
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)

    // Report last-read position to hub (pagehide/visibility/switch, low-frequency)
    useReadPositionReporter({
        api: props.api,
        sessionId: props.sessionId,
        getAnchorMessageId: () => {
            const viewport = viewportRef.current
            if (!viewport) return null
            return captureReadPositionAnchor(viewport)
        },
        lastKnownHubReadAt: props.hubLastReadAt
    })

    const loadLockRef = useRef(false)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isLoadingMessagesRef = useRef(props.isLoadingMessages)
    const hasLoadedMessagesRef = useRef(props.hasLoadedMessages)
    const messagesVersionRef = useRef(props.messagesVersion)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const pendingLoadPromiseRef = useRef<Promise<boolean> | null>(null)
    const pendingLoadResolveRef = useRef<((value: boolean) => void) | null>(null)
    const pendingLoadBaselineRef = useRef<{ messagesVersion: number; hasMoreMessages: boolean } | null>(null)
    const atBottomRef = useRef(true)
    const onAtBottomChangeRef = useRef(props.onAtBottomChange)
    const onFlushPendingRef = useRef(props.onFlushPending)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const pendingSavedScrollRef = useRef<PersistedChatScrollPosition | null>(readChatScrollPosition(props.sessionId))
    // Initial-position target mode: when locatorTargetMessageId is set, the
    // viewport must land on it (NOT saved/bottom). Stays active until the
    // target's DOM node is scrolled into view, or bounded retries exhaust
    // (target filtered/grouped → fallback to default positioning).
    const locatorTargetActiveRef = useRef(props.locatorTargetMessageId !== null && props.locatorTargetMessageId !== undefined)
    const locatorTargetRetriesRef = useRef(0)
    const ignoreNextRestorationScrollRef = useRef(false)
    const pendingSendScrollRef = useRef<{ deadline: number; previousMessageId: string | null } | null>(null)
    const pendingBottomScrollRef = useRef(false)
    const pendingBottomFlushCompleteRef = useRef(false)
    const pendingBottomDeadlineRef = useRef(0)
    const pendingBottomTimersRef = useRef<number[]>([])
    const persistTimerRef = useRef<number | null>(null)
    const mountedRef = useRef(true)
    const pendingCountRef = useRef(props.pendingCount)
    const findLatestUserMessageIdRef = useRef(props.findLatestUserMessageId)
    pendingCountRef.current = props.pendingCount

    // Smart scroll state: enabled only while the user is intentionally at the bottom.
    const autoScrollEnabledRef = useRef(true)
    useEffect(() => {
        onAtBottomChangeRef.current = props.onAtBottomChange
    }, [props.onAtBottomChange])
    useEffect(() => {
        onFlushPendingRef.current = props.onFlushPending
    }, [props.onFlushPending])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        isLoadingMessagesRef.current = props.isLoadingMessages
    }, [props.isLoadingMessages])
    useEffect(() => {
        hasLoadedMessagesRef.current = props.hasLoadedMessages
    }, [props.hasLoadedMessages])
    useEffect(() => {
        messagesVersionRef.current = props.messagesVersion
    }, [props.messagesVersion])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        findLatestUserMessageIdRef.current = props.findLatestUserMessageId
    }, [props.findLatestUserMessageId])

    const settlePendingLoad = useCallback((result: boolean) => {
        const resolve = pendingLoadResolveRef.current
        const baseline = pendingLoadBaselineRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        pendingLoadBaselineRef.current = null
        if (!resolve) {
            return
        }
        if (!result || !baseline) {
            resolve(result)
            return
        }
        resolve(
            messagesVersionRef.current !== baseline.messagesVersion
            || hasMoreMessagesRef.current !== baseline.hasMoreMessages
        )
    }, [])

    // atBottom / autoScroll 同步工具（组件级 useCallback，供 scroll 监听与 ResizeObserver 复用）。
    // 锁步更新两个 ref；atBottom 变化时触发 onAtBottomChange，true 时 flush pending。
    const setAutoScrollMode = useCallback((enabled: boolean) => {
        if (autoScrollEnabledRef.current === enabled) {
            return
        }
        autoScrollEnabledRef.current = enabled
    }, [])
    const setAtBottomMode = useCallback((atBottom: boolean) => {
        if (atBottom === atBottomRef.current) {
            return
        }
        atBottomRef.current = atBottom
        onAtBottomChangeRef.current(atBottom)
        if (atBottom && !pendingBottomScrollRef.current) {
            onFlushPendingRef.current()
        }
    }, [])
    // L1.1：重算当前滚动位置并同步 atBottom/autoScroll（ResizeObserver 内容增高时只同步、不主动滚）。
    const recomputeAtBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        const intent = getScrollIntent({
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            previousScrollTop: lastScrollTopRef.current
        })
        lastScrollTopRef.current = viewport.scrollTop
        setAutoScrollMode(intent.isNearBottom)
        setAtBottomMode(intent.isNearBottom)
    }, [setAutoScrollMode, setAtBottomMode])

    const persistViewportPosition = useCallback((viewport: HTMLElement) => {
        writeChatScrollPosition(props.sessionId, {
            scrollTop: viewport.scrollTop,
            anchor: captureScrollAnchor(viewport)
        })
    }, [props.sessionId])

    const scheduleViewportPositionPersist = useCallback((viewport: HTMLElement) => {
        if (persistTimerRef.current !== null) {
            window.clearTimeout(persistTimerRef.current)
        }
        persistTimerRef.current = window.setTimeout(() => {
            persistTimerRef.current = null
            if (pendingSavedScrollRef.current === null) {
                persistViewportPosition(viewport)
            }
        }, SCROLL_PERSIST_DELAY_MS)
    }, [persistViewportPosition])

    const clearPendingBottomScroll = useCallback(() => {
        pendingBottomScrollRef.current = false
        pendingBottomFlushCompleteRef.current = false
        pendingBottomDeadlineRef.current = 0
        for (const timer of pendingBottomTimersRef.current) {
            window.clearTimeout(timer)
        }
        pendingBottomTimersRef.current = []
    }, [])

    const finishPendingBottomScroll = useCallback((): boolean => {
        if (!pendingBottomScrollRef.current) return false
        if (Date.now() > pendingBottomDeadlineRef.current) {
            clearPendingBottomScroll()
            return false
        }
        const viewport = viewportRef.current
        if (!viewport) return false
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        lastScrollTopRef.current = viewport.scrollTop
        if (pendingBottomFlushCompleteRef.current && pendingCountRef.current === 0) {
            clearPendingBottomScroll()
        }
        return true
    }, [clearPendingBottomScroll])

    const beginPendingBottomScroll = useCallback(() => {
        if (pendingBottomScrollRef.current) return
        pendingSavedScrollRef.current = null
        pendingBottomScrollRef.current = true
        pendingBottomFlushCompleteRef.current = false
        pendingBottomDeadlineRef.current = Date.now() + BOTTOM_SCROLL_TIMEOUT_MS
        const finishFlush = () => {
            if (!mountedRef.current) return
            pendingBottomFlushCompleteRef.current = true
            for (const delay of [0, 50, 200, 500]) {
                pendingBottomTimersRef.current.push(window.setTimeout(finishPendingBottomScroll, delay))
            }
        }
        try {
            Promise.resolve(onFlushPendingRef.current()).then(finishFlush, finishFlush)
        } catch {
            finishFlush()
        }
        finishPendingBottomScroll()
    }, [finishPendingBottomScroll])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        lastScrollTopRef.current = viewport.scrollTop

        const handleScroll = () => {
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: lastScrollTopRef.current
            })
            lastScrollTopRef.current = viewport.scrollTop
            if (ignoreNextRestorationScrollRef.current) {
                ignoreNextRestorationScrollRef.current = false
                return
            }
            if (pendingSavedScrollRef.current === null) {
                scheduleViewportPositionPersist(viewport)
            }

            if (intent.isScrollingUp && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX) {
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return
            }

            if (intent.isNearBottom) {
                if (pendingCountRef.current > 0) {
                    beginPendingBottomScroll()
                }
                setAutoScrollMode(true)
                setAtBottomMode(true)
                return
            }

            setAutoScrollMode(false)
            setAtBottomMode(false)
        }

        const cancelSavedRestore = () => {
            ignoreNextRestorationScrollRef.current = false
            clearPendingBottomScroll()
            if (pendingSavedScrollRef.current !== null) {
                pendingSavedScrollRef.current = null
                persistViewportPosition(viewport)
            }
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('wheel', cancelSavedRestore, { passive: true })
        viewport.addEventListener('touchstart', cancelSavedRestore, { passive: true })
        viewport.addEventListener('pointerdown', cancelSavedRestore, { passive: true })
        return () => {
            if (persistTimerRef.current !== null) {
                window.clearTimeout(persistTimerRef.current)
                persistTimerRef.current = null
            }
            if (pendingSavedScrollRef.current === null) {
                persistViewportPosition(viewport)
            }
            clearPendingBottomScroll()
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('wheel', cancelSavedRestore)
            viewport.removeEventListener('touchstart', cancelSavedRestore)
            viewport.removeEventListener('pointerdown', cancelSavedRestore)
        }
    }, [
        beginPendingBottomScroll,
        clearPendingBottomScroll,
        persistViewportPosition,
        props.sessionId,
        scheduleViewportPositionPersist,
        setAtBottomMode,
        setAutoScrollMode
    ])

    const requestBottomScroll = useCallback(() => {
        beginPendingBottomScroll()
        autoScrollEnabledRef.current = true
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onAtBottomChangeRef.current(true)
        }
        finishPendingBottomScroll()
    }, [beginPendingBottomScroll, finishPendingBottomScroll])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            settlePendingLoad(false)
            clearPendingBottomScroll()
        }
    }, [clearPendingBottomScroll, settlePendingLoad])

    const restoreSavedPosition = useCallback((): boolean => {
        // Target mode owns the initial position — saved must not override it
        // (the cross-device case where saved is stale and hub target won LWW).
        if (locatorTargetActiveRef.current) return false
        const viewport = viewportRef.current
        const saved = pendingSavedScrollRef.current
        if (!viewport || saved === null) return false

        if (saved.anchor) {
            const target = document.getElementById(saved.anchor.id)
            if (target && viewport.contains(target)) {
                ignoreNextRestorationScrollRef.current = true
                restoreScrollAnchor(viewport, saved.anchor)
                pendingSavedScrollRef.current = null
                lastScrollTopRef.current = viewport.scrollTop
                window.requestAnimationFrame(() => {
                    ignoreNextRestorationScrollRef.current = false
                })
                recomputeAtBottom()
                return true
            }
            if (!hasLoadedMessagesRef.current) {
                setAutoScrollMode(false)
                return false
            }
            if (hasMoreMessagesRef.current || isLoadingMessagesRef.current || isLoadingMoreRef.current) {
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return false
            }
        }

        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        const resolved = resolveSavedScrollPosition(
            saved.scrollTop,
            maxScrollTop,
            false
        )
        ignoreNextRestorationScrollRef.current = true
        viewport.scrollTop = resolved.scrollTop
        window.requestAnimationFrame(() => {
            ignoreNextRestorationScrollRef.current = false
        })
        lastScrollTopRef.current = viewport.scrollTop
        pendingSavedScrollRef.current = resolved.pendingScrollTop === null
            ? null
            : { ...saved, scrollTop: resolved.pendingScrollTop }
        if (pendingSavedScrollRef.current === null) {
            recomputeAtBottom()
        } else {
            setAutoScrollMode(false)
            setAtBottomMode(false)
        }
        return true
    }, [recomputeAtBottom, setAtBottomMode, setAutoScrollMode])

    // Initial-position target mode (§4.3 落 target). When a locator target is
    // set, disable saved restoration and scroll the target into view once its
    // DOM renders. Retries ride messagesVersion (window load / SSE); bounded
    // fallback if the target never renders (filtered/grouped message).
    useLayoutEffect(() => {
        const target = props.locatorTargetMessageId
        if (!target) {
            locatorTargetActiveRef.current = false
            return
        }
        // Same-device refresh: locator target IS the saved anchor. Let saved
        // restore handle it pixel-precise (matching the no-refresh behavior).
        // Only activate locator scroll mode for the cross-device case (target
        // came from hub, differs from local saved).
        const saved = readChatScrollPosition(props.sessionId)
        if (saved?.anchor?.messageId === target) {
            locatorTargetActiveRef.current = false
            return
        }
        locatorTargetActiveRef.current = true
        locatorTargetRetriesRef.current = 0
        pendingSavedScrollRef.current = null
    }, [props.locatorTargetMessageId, props.sessionId])

    useLayoutEffect(() => {
        const target = props.locatorTargetMessageId
        if (!target || !locatorTargetActiveRef.current) return
        const viewport = viewportRef.current
        if (!viewport) return
        const el = document.getElementById(`hapi-message-${target}`)
        if (el && viewport.contains(el)) {
            el.scrollIntoView({ block: 'start' })
            ignoreNextRestorationScrollRef.current = true
            lastScrollTopRef.current = viewport.scrollTop
            requestAnimationFrame(() => {
                ignoreNextRestorationScrollRef.current = false
                if (viewportRef.current) {
                    lastScrollTopRef.current = viewportRef.current.scrollTop
                }
            })
            locatorTargetActiveRef.current = false
            recomputeAtBottom()
            return
        }
        locatorTargetRetriesRef.current += 1
        if (locatorTargetRetriesRef.current > 20) {
            // Bounded fallback: target never rendered — release target mode so
            // default positioning (recomputeAtBottom) can settle the viewport.
            locatorTargetActiveRef.current = false
        }
    }, [props.locatorTargetMessageId, props.messagesVersion, recomputeAtBottom])

    const scrollToSentMessage = useCallback((): boolean => {
        const pending = pendingSendScrollRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) return false
        if (Date.now() > pending.deadline) {
            pendingSendScrollRef.current = null
            return false
        }
        const messageId = findLatestUserMessageIdRef.current()
        if (!messageId || messageId === pending.previousMessageId) return false
        const target = document.getElementById(getConversationMessageAnchorId(messageId))
        if (!target || !viewport.contains(target)) return false

        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        lastScrollTopRef.current = viewport.scrollTop
        pendingSavedScrollRef.current = null
        clearPendingBottomScroll()
        pendingSendScrollRef.current = null
        autoScrollEnabledRef.current = false
        setAtBottomMode(false)
        return true
    }, [clearPendingBottomScroll, setAtBottomMode])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) return
        forceScrollTokenRef.current = props.forceScrollToken
        pendingSavedScrollRef.current = null
        clearPendingBottomScroll()
        pendingSendScrollRef.current = {
            deadline: Date.now() + SEND_SCROLL_TIMEOUT_MS,
            previousMessageId: props.sendScrollPreviousMessageId
        }
        const timers = [0, 50, 200, 500, 1000].map((delay) => window.setTimeout(scrollToSentMessage, delay))
        return () => timers.forEach((timer) => window.clearTimeout(timer))
    }, [clearPendingBottomScroll, props.forceScrollToken, props.sendScrollPreviousMessageId, scrollToSentMessage])

    const loadOlderPreservingScroll = useCallback((): Promise<boolean> => {
        if (pendingLoadPromiseRef.current) {
            return pendingLoadPromiseRef.current
        }
        if (
            isLoadingMessagesRef.current
            || !hasMoreMessagesRef.current
            || isLoadingMoreRef.current
            || loadLockRef.current
        ) {
            return Promise.resolve(false)
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return Promise.resolve(false)
        }
        pendingScrollRef.current = {
            anchor: captureScrollAnchor(viewport),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight
        }
        autoScrollEnabledRef.current = false
        loadLockRef.current = true
        loadStartedRef.current = false
        pendingLoadBaselineRef.current = {
            messagesVersion: messagesVersionRef.current,
            hasMoreMessages: hasMoreMessagesRef.current
        }
        const loadPromise = new Promise<boolean>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        try {
            void onLoadMoreRef.current().catch((error) => {
                pendingScrollRef.current = null
                loadLockRef.current = false
                settlePendingLoad(false)
                console.error('Failed to load older messages:', error)
            }).finally(() => {
                if (!loadStartedRef.current && !isLoadingMoreRef.current) {
                    if (pendingScrollRef.current) {
                        pendingScrollRef.current = null
                        loadLockRef.current = false
                    }
                    settlePendingLoad(true)
                }
            })
        } catch (error) {
            pendingScrollRef.current = null
            loadLockRef.current = false
            settlePendingLoad(false)
            console.error('Failed to load older messages:', error)
        }
        return loadPromise
    }, [settlePendingLoad])

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const target = await locateOutlineTargetMessage({
            targetMessageId: item.targetMessageId,
            findTarget: (anchorId) => document.getElementById(anchorId),
            hasMoreMessages: () => hasMoreMessagesRef.current,
            loadOlderPreservingScroll
        })
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' })
            autoScrollEnabledRef.current = false
        }
        props.onOutlineItemClick?.(item)
        props.onOutlineOpenChange(false)
    }, [loadOlderPreservingScroll, props.onOutlineItemClick, props.onOutlineOpenChange])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            if (pendingScrollRef.current) {
                return
            }
            if (scrollToSentMessage()) return
            if (restoreSavedPosition()) return
            if (pendingSavedScrollRef.current?.anchor && hasMoreMessagesRef.current) {
                void loadOlderPreservingScroll()
                return
            }
            if (finishPendingBottomScroll()) return
            recomputeAtBottom()
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [finishPendingBottomScroll, loadOlderPreservingScroll, recomputeAtBottom, restoreSavedPosition, scrollToSentMessage])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            const restoredByAnchor = pending.anchor ? restoreScrollAnchor(viewport, pending.anchor) : false
            if (!restoredByAnchor) {
                const delta = viewport.scrollHeight - pending.scrollHeight
                viewport.scrollTop = pending.scrollTop + delta
            }
            lastScrollTopRef.current = viewport.scrollTop
            pendingScrollRef.current = null
            loadLockRef.current = false
            settlePendingLoad(true)
            return
        }
        if (scrollToSentMessage()) return
        if (restoreSavedPosition()) return
        if (pendingSavedScrollRef.current?.anchor && hasMoreMessagesRef.current) {
            void loadOlderPreservingScroll()
            return
        }
        finishPendingBottomScroll()
        recomputeAtBottom()
    }, [props.messagesVersion, finishPendingBottomScroll, loadOlderPreservingScroll, recomputeAtBottom, restoreSavedPosition, scrollToSentMessage, settlePendingLoad])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (props.isLoadingMoreMessages) {
            loadStartedRef.current = true
        }
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages) {
            if (pendingScrollRef.current) {
                pendingScrollRef.current = null
                loadLockRef.current = false
            }
            settlePendingLoad(true)
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages, settlePendingLoad])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            terminalToolDisplayMode,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage,
            hasMoreMessages: props.hasMoreMessages,
            isLoadingMoreMessages: props.isLoadingMoreMessages,
            loadOlderMessagesPreservingScroll: loadOlderPreservingScroll
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div ref={viewportRef} className="app-scroll-y min-h-0 flex-1 overflow-x-hidden">
                        <div ref={contentRef} className="mx-auto w-full max-w-content min-w-0 p-3">
                            <div className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {props.hasMoreMessages && !props.isLoadingMessages ? (
                                        <div className="py-1 mb-2">
                                            <div className="mx-auto w-fit">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        void loadOlderPreservingScroll()
                                                    }}
                                                    disabled={props.isLoadingMoreMessages || props.isLoadingMessages}
                                                    aria-busy={props.isLoadingMoreMessages}
                                                    className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                                >
                                                    {props.isLoadingMoreMessages ? (
                                                        <>
                                                            <Spinner size="sm" label={null} className="text-current" />
                                                            {t('misc.loading')}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span aria-hidden="true">↑</span>
                                                            {t('misc.loadOlder')}
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={props.pendingCount} onClick={requestBottomScroll} />
                {props.hasNewer ? (
                    <LoadNewerIndicator
                        loading={props.isLoadingMoreMessages}
                        onClick={() => { void props.onFetchNewer() }}
                    />
                ) : null}
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        <ConversationOutlinePanel
                            title={props.outlineTitle}
                            items={props.outlineItems}
                            hasMoreMessages={props.hasMoreMessages}
                            isLoadingMoreMessages={props.isLoadingMoreMessages}
                            onLoadMore={() => {
                                void loadOlderPreservingScroll()
                            }}
                            onSelect={handleOutlineSelect}
                            onClose={() => props.onOutlineOpenChange(false)}
                        />
                    </>
                ) : null}
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
