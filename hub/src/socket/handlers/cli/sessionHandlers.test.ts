import { describe, expect, it } from 'bun:test'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

describe('auto-resume hook (onAutoResumeSchedule)', () => {
    function syntheticContent(text: string, model = '<synthetic>'): unknown {
        return {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    message: {
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [{ type: 'text', text }]
                    }
                }
            }
        }
    }

    const QUOTA_TEXT =
        'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。]'

    it('invokes onAutoResumeSchedule with sid + code + reset time for a synthetic quota error', () => {
        const calls: Array<{ sid: string; resetsAtMs: number; code: string }> = []
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('auto-resume-quota', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onAutoResumeSchedule: (sid, resetsAtMs, code) => calls.push({ sid, resetsAtMs, code })
        })

        socket.trigger('message', { sid: session.id, message: syntheticContent(QUOTA_TEXT) })

        expect(calls).toHaveLength(1)
        expect(calls[0].sid).toBe(session.id)
        expect(calls[0].code).toBe('1308')
        expect(new Date(calls[0].resetsAtMs).getHours()).toBe(16)
        // The synthetic message itself is still persisted (hook does not block ingress).
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('does NOT invoke onAutoResumeSchedule for agent-authored discussion (real model name)', () => {
        const calls: Array<{ sid: string; resetsAtMs: number; code: string }> = []
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('auto-resume-negative', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onAutoResumeSchedule: (sid, resetsAtMs, code) => calls.push({ sid, resetsAtMs, code })
        })

        socket.trigger('message', { sid: session.id, message: syntheticContent(QUOTA_TEXT, 'glm-5.2') })

        expect(calls).toHaveLength(0)
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('does NOT invoke onAutoResumeSchedule for transient errors without a reset time', () => {
        const calls: Array<{ sid: string; resetsAtMs: number; code: string }> = []
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('auto-resume-transient', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onAutoResumeSchedule: (sid, resetsAtMs, code) => calls.push({ sid, resetsAtMs, code })
        })

        socket.trigger('message', { sid: session.id, message: syntheticContent('[1302]请您控制请求频率') })

        expect(calls).toHaveLength(0)
    })

    it('never throws on malformed content (hook is isolated from main persistence)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('auto-resume-malformed', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onAutoResumeSchedule: () => {
                throw new Error('should not be called for malformed content')
            }
        })

        // Valid message shell, but inner data.message missing — must not throw,
        // must persist the row, must not schedule.
        expect(() =>
            socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content: { type: 'output', data: {} } }
            })
        ).not.toThrow()
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('survives a throwing onAutoResumeSchedule callback (main flow unaffected)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('auto-resume-throw', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onAutoResumeSchedule: () => {
                throw new Error('boom')
            }
        })

        expect(() =>
            socket.trigger('message', { sid: session.id, message: syntheticContent(QUOTA_TEXT) })
        ).not.toThrow()
        // Synthetic row still persisted + broadcast despite the callback throwing.
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
        expect(socket.roomEvents.some((e) => e.event === 'update')).toBe(true)
    })
})

describe('cli session handlers', () => {
    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: redundantGoalStatusContent('Goal active · 8016 tokens')
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
    })
})
