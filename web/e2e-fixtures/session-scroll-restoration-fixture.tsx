import React, { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    useNavigate,
    useParams,
    useRouter,
} from '@tanstack/react-router'
import { getElementScrollRestorationEntry } from '@tanstack/router-core'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage } from '../src/types/api'
import {
    clearMessageWindow,
    fetchLatestMessages,
    getMessageWindowState,
    ingestIncomingMessages,
    subscribeMessageWindow,
    type MessageWindowState,
} from '../src/lib/message-window-store'
import { getScrollRestorationKey } from '../src/lib/scrollRestorationKey'
import { freezeRestoredSessionMessageWindow } from '../src/lib/sessionEntryScrollRestoration'

const runId = new URLSearchParams(window.location.search).get('run') ?? 'default'
const sessionA = `scroll-a-${runId}`
const sessionB = `scroll-b-${runId}`
const rowHeight = 64

declare global {
    interface Window {
        __sessionScrollE2E?: {
            sessionA: string
            sessionB: string
        }
    }
}

function makeMessage(sessionId: string, index: number): DecryptedMessage {
    return {
        id: `${sessionId}-message-${index}`,
        seq: index,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: `${sessionId} message ${index}`,
                },
            },
        },
        createdAt: 1_700_000_000_000 + index,
        invokedAt: 1_700_000_000_000 + index,
    } as DecryptedMessage
}

function makeRange(sessionId: string, start: number, count: number): DecryptedMessage[] {
    return Array.from({ length: count }, (_, index) => makeMessage(sessionId, start + index))
}

clearMessageWindow(sessionA)
clearMessageWindow(sessionB)
// A represents an already-opened long session. Returning after 50 new rows
// would trim the oldest 50 rows if the entry fetch replaced this window.
ingestIncomingMessages(sessionA, makeRange(sessionA, 0, 400))

const requestCount = new Map<string, number>()
const api = {
    getMessages: async (sessionId: string) => {
        const count = (requestCount.get(sessionId) ?? 0) + 1
        requestCount.set(sessionId, count)
        if (sessionId === sessionA) {
            return {
                messages: count === 1
                    ? makeRange(sessionA, 350, 50)
                    : makeRange(sessionA, 400, 50),
                page: { limit: 50, nextBeforeAt: null, nextBeforeSeq: null, hasMore: false },
            }
        }
        return {
            messages: makeRange(sessionB, 0, 50),
            page: { limit: 50, nextBeforeAt: null, nextBeforeSeq: null, hasMore: false },
        }
    },
} as unknown as ApiClient

function useMessageWindow(sessionId: string): MessageWindowState {
    return useSyncExternalStore(
        useCallback((listener) => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId]),
    )
}

function FixtureRoot() {
    const navigate = useNavigate()
    return (
        <main>
            <button
                data-testid="open-a"
                type="button"
                onClick={() => navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: sessionA },
                    replace: true,
                })}
            >
                Open A
            </button>
            <button
                data-testid="open-b"
                type="button"
                onClick={() => navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: sessionB },
                    replace: true,
                })}
            >
                Open B
            </button>
            <Outlet />
        </main>
    )
}

function SessionFixture() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    return <SessionThread key={sessionId} sessionId={sessionId} />
}

function SessionThread(props: { sessionId: string }) {
    const router = useRouter({ warn: false })
    const state = useMessageWindow(props.sessionId)
    const viewportRef = useRef<HTMLDivElement | null>(null)

    useLayoutEffect(() => {
        freezeRestoredSessionMessageWindow(router, props.sessionId)
    }, [props.sessionId, router])

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport || !state.hasLoadedLatest || state.messages.length === 0) {
            return
        }
        const saved = getElementScrollRestorationEntry(router, {
            id: `chat-${props.sessionId}`,
            getKey: getScrollRestorationKey,
        })
        viewport.scrollTop = saved?.scrollY ?? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    }, [props.sessionId, router, state.hasLoadedLatest, state.messages.length, state.messagesVersion])

    useEffect(() => {
        void fetchLatestMessages(api, props.sessionId)
    }, [props.sessionId])

    return (
        <section
            data-testid="thread"
            data-session={props.sessionId}
            data-loaded={state.hasLoadedLatest ? 'true' : 'false'}
        >
            <div data-testid="pending-count">{state.pendingCount}</div>
            <div
                ref={viewportRef}
                data-testid="message-viewport"
                data-scroll-restoration-id={`chat-${props.sessionId}`}
                style={{ border: '1px solid black', height: 256, overflowY: 'auto', width: 480 }}
            >
                {state.messages.map((message) => (
                    <div
                        key={message.id}
                        id={message.id}
                        data-testid="message-row"
                        data-message-id={message.id}
                        style={{ boxSizing: 'border-box', height: rowHeight, padding: 8 }}
                    >
                        {message.id}
                    </div>
                ))}
            </div>
        </section>
    )
}

const rootRoute = createRootRoute({ component: FixtureRoot })
const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    component: SessionFixture,
})
const routeTree = rootRoute.addChildren([sessionRoute])
const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/sessions/${sessionA}`] }),
    scrollRestoration: true,
    getScrollRestorationKey,
})

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

window.__sessionScrollE2E = { sessionA, sessionB }

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(<RouterProvider router={router} />)
}
