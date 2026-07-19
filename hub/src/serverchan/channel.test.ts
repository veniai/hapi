import { describe, expect, it, mock } from 'bun:test'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { ServerChanChannel } from './channel'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: 'F:\\develop\\code\\usdt',
            host: 'DESKTOP'
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        lastReadMessageId: null,
        lastReadAt: null,
        attentionRev: 0,
        handledRev: 0,
        ...overrides
    }
}

describe('ServerChanChannel', () => {
    it('does not send completed task notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'completed',
                summary: 'Subtask finished'
            })

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends failed task notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Task failed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends session completion notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                id: 'session-complete',
                metadata: {
                    path: 'F:\\develop\\code\\usdt',
                    host: 'DESKTOP',
                    name: 'USDT review'
                }
            }), 'completed' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Session completed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('suppresses all send* when web tab is visible', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                { hasVisibleConnection: () => true } as never
            )
            await channel.sendReady(createSession())
            await channel.sendPermissionRequest(createSession())
            await channel.sendTaskNotification(createSession(), { status: 'failed', summary: 'boom' })
            await channel.sendSessionCompletion(createSession(), 'completed' as SessionEndReason)
            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends normally when web tab is not visible', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                { hasVisibleConnection: () => false } as never
            )
            await channel.sendReady(createSession())
            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
