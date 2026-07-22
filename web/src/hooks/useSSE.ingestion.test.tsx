import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSSE } from './useSSE'
import {
    clearMessageWindow,
    getMessageWindowState,
    hasMessageWindow,
    ingestIncomingMessages,
} from '@/lib/message-window-store'
import type { DecryptedMessage, SyncEvent } from '@/types/api'

/**
 * Integration test: drive the real `useSSE` hook with a fake EventSource and
 * verify the merged global connection ingests message-received into opened
 * session windows (incl. scheduled), and gates on hasMessageWindow. This covers
 * the SSE→store wiring that the pure-function tests can't reach (Codex review
 * suggestion #3).
 */

interface FakeEventSource {
    onmessage: ((ev: { data: string }) => void) | null
    onopen: (() => void) | null
    onerror: ((ev: unknown) => void) | null
    readyState: number
    url: string
    close(): void
}

class FakeEventSourceImpl {
    onmessage: ((ev: { data: string }) => void) | null = null
    onopen: (() => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    readyState = 1 // OPEN
    static last: FakeEventSourceImpl | null = null
    constructor(public url: string) {
        FakeEventSourceImpl.last = this
    }
    close() {
        this.readyState = 2 // CLOSED
    }
}

const OriginalEventSource = globalThis.EventSource

function makeMsg(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    const id = overrides.id ?? 'msg-1'
    return {
        id,
        seq: null,
        localId: overrides.localId ?? id,
        content: { role: 'user', content: { type: 'text', text: 'hello' } },
        createdAt: 1_700_000_000_000,
        invokedAt: null,
        status: 'queued',
        ...overrides,
    }
}

function emit(event: SyncEvent): void {
    const es = FakeEventSourceImpl.last as unknown as FakeEventSource | null
    if (!es?.onmessage) {
        throw new Error('no live EventSource / onmessage not bound')
    }
    act(() => {
        es.onmessage!({ data: JSON.stringify(event) })
    })
}

function useWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <QueryClientProvider client={queryClient}>
                {children}
            </QueryClientProvider>
        )
    }
}

const HOOK_OPTS = {
    enabled: true,
    token: 't',
    baseUrl: 'http://hub',
    subscription: { all: true },
    scope: 'global' as const,
    onConnect: () => {},
    onEvent: () => {},
    onToast: () => {},
}

describe('useSSE global ingestion (merged connection)', () => {
    let queryClient: QueryClient

    beforeEach(() => {
        globalThis.EventSource = FakeEventSourceImpl as unknown as typeof EventSource
        FakeEventSourceImpl.last = null
        queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    })

    afterEach(() => {
        globalThis.EventSource = OriginalEventSource
        for (const id of ['ingest-A', 'ingest-sched', 'ingest-never']) {
            clearMessageWindow(id)
        }
    })

    it('ingests a live message-received into an already-opened session window', () => {
        ingestIncomingMessages('ingest-A', [makeMsg({ id: 'a-seed' })])
        renderHook(() => useSSE(HOOK_OPTS), { wrapper: useWrapper(queryClient) })
        act(() => FakeEventSourceImpl.last!.onopen!())

        emit({
            type: 'message-received',
            sessionId: 'ingest-A',
            message: makeMsg({ id: 'a-live' }),
        } as SyncEvent)

        expect(getMessageWindowState('ingest-A').messages.map((m) => m.id)).toContain('a-live')
    })

    it('also ingests scheduled (queued-for-future) messages — regression guard', () => {
        ingestIncomingMessages('ingest-sched', [makeMsg({ id: 's-seed' })])
        renderHook(() => useSSE(HOOK_OPTS), { wrapper: useWrapper(queryClient) })
        act(() => FakeEventSourceImpl.last!.onopen!())

        emit({
            type: 'message-received',
            sessionId: 'ingest-sched',
            message: makeMsg({ id: 's-future', scheduledAt: 9_999_999_999_000 }),
        } as SyncEvent)

        expect(getMessageWindowState('ingest-sched').messages.map((m) => m.id)).toContain('s-future')
    })

    it('does NOT create a window for a session the user never opened (hasMessageWindow gate)', () => {
        renderHook(() => useSSE(HOOK_OPTS), { wrapper: useWrapper(queryClient) })
        act(() => FakeEventSourceImpl.last!.onopen!())

        emit({
            type: 'message-received',
            sessionId: 'ingest-never',
            message: makeMsg({ id: 'n-live' }),
        } as SyncEvent)

        expect(hasMessageWindow('ingest-never')).toBe(false)
    })
})
