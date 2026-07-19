import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        lastReadMessageId: null,
        lastReadAt: null,
        attentionRev: 0,
        handledRev: 0,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                {children}
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionList directory action', () => {
    it('starts a new session with the project machine and directory', () => {
        const onNewSessionInDirectory = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Greeting',
                flavor: 'codex',
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={onNewSessionInDirectory}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/home/ubuntu',
        })
    })

    it('hides the directory action for sessions without path metadata', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({ id: 'session-without-path' })]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        expect(screen.queryByRole('button', { name: 'New session in this directory' })).toBeNull()
    })
})

describe('SessionList collapse behavior', () => {
    function renderSessionList(sessions: SessionSummary[], selectedSessionId = 'session-running') {
        return (
            <QueryClientProvider client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                }
            })}>
                <I18nProvider>
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={vi.fn()}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        renderHeader={false}
                        api={null}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )
    }

    function getProjectPanel(): Element {
        const header = screen.getByTitle('/work/hapi')
        const panel = header.nextElementSibling
        if (!panel) {
            throw new Error('Expected project collapse panel')
        }
        return panel
    }

    it('keeps hierarchy readable with compact edge-aligned indentation', () => {
        const { container } = render(renderSessionList([
            makeSession({
                id: 'session-running',
                active: true,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            })
        ]))

        expect(container.querySelector('[data-session-list-level="machine"]')?.className).toContain('px-1')
        expect(container.querySelector('[data-session-list-level="project"]')?.className).toContain('ml-2')
        expect(container.querySelector('[data-session-list-level="session"]')?.className).toContain('ml-2')
    })

    it('colors unread titles and times but leaves archived sessions muted', () => {
        localStorage.clear()
        render(renderSessionList([
            makeSession({
                id: 'unread',
                active: true,
                attentionRev: 1,
                updatedAt: 200,
                metadata: { path: '/work/hapi', name: 'Unread task', flavor: 'codex' },
            }),
            makeSession({
                id: 'archived',
                updatedAt: 200,
                metadata: {
                    path: '/work/hapi',
                    name: 'Archived task',
                    flavor: 'codex',
                    lifecycleState: 'archived'
                },
            })
        ], 'another-session'))

        expect(screen.getByText('Unread task').className).toContain('text-red-500')
        expect(screen.getByText('Unread task').closest('button')?.querySelectorAll('.text-red-500')).toHaveLength(2)
        expect(screen.getByText('Archived task').className).not.toContain('text-red-500')
    })

    it('re-clicking the selected row clears the revision on this device', () => {
        localStorage.clear()
        const onSelect = vi.fn()
        const session = makeSession({
            id: 'selected-attention',
            active: true,
            attentionRev: 4,
            metadata: { path: '/work/hapi', name: 'Selected attention', flavor: 'codex' },
        })
        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={session.id}
                onSelect={onSelect}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        const row = screen.getByText('Selected attention').closest('button')!
        fireEvent.mouseDown(row, { button: 0 })
        fireEvent.mouseUp(row, { button: 0 })

        expect(getSessionLastSeenAt(session.id)).toBe(4)
        expect(onSelect).toHaveBeenCalledWith(session.id)
    })

    it('keeps a selected running path collapsed across live session-list refreshes', async () => {
        const baseSessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                pendingRequestsCount: 1,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-old',
                updatedAt: 50,
                metadata: { path: '/work/hapi', name: 'Older task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(baseSessions))

        expect(getProjectPanel().getAttribute('data-open')).toBe('true')

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList([
            {
                ...baseSessions[0]!,
                pendingRequestsCount: 2,
                updatedAt: 200,
            },
            baseSessions[1]!
        ]))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBeNull()
        })
    })

    it('auto-expands the path again when the selected session changes', async () => {
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-next',
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Next task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(sessions))

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList(sessions, 'session-next'))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBe('true')
        })
    })
})
