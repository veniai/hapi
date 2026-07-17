import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { getPendingInboxSessions, PendingInboxFab } from './PendingInboxFab'

const navigateMock = vi.fn()
let selectedSessionId: string | null = null
let sessions: SessionSummary[] = []

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useMatchRoute: () => () => selectedSessionId ? { sessionId: selectedSessionId } : false
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} })
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions })
}))

vi.mock('@/hooks/useSessionLastSeen', () => ({
    useSessionLastSeenVersion: () => 0
}))

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 100,
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
        ...overrides
    }
}

describe('getPendingInboxSessions', () => {
    it('keeps actionable active sessions and excludes archived, selected, thinking, and background sessions', () => {
        const candidates = [
            makeSession({ id: 'permission', pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'input', pendingRequestKinds: ['input'] }),
            makeSession({ id: 'unread', updatedAt: 200 }),
            makeSession({ id: 'archived', active: false, updatedAt: 200 }),
            makeSession({ id: 'selected', pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'thinking', thinking: true, updatedAt: 200 }),
            makeSession({ id: 'background', backgroundTaskCount: 1, updatedAt: 200 })
        ]

        const result = getPendingInboxSessions(candidates, 'selected', {
            permission: 100,
            input: 100,
            unread: 100,
            archived: 100,
            selected: 100,
            thinking: 100,
            background: 100
        })

        expect(result.map(session => session.id)).toEqual(['permission', 'input', 'unread'])
    })
})

describe('PendingInboxFab', () => {
    beforeEach(() => {
        navigateMock.mockClear()
        selectedSessionId = null
        localStorage.clear()
        sessions = [
            makeSession({ id: 'first', pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'second', pendingRequestKinds: ['input'] }),
            makeSession({ id: 'closed', active: false, pendingRequestKinds: ['permission'] })
        ]
    })

    it('navigates through the queue instead of getting stuck on the current route', () => {
        const { rerender } = render(<PendingInboxFab />)

        fireEvent.click(screen.getByRole('button', { name: '待处理 2 个会话' }))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'first' }
        })

        selectedSessionId = 'first'
        rerender(<PendingInboxFab />)
        fireEvent.click(screen.getByRole('button', { name: '待处理 1 个会话' }))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'second' }
        })
    })

    it('uses the raised safe-area-aware position', () => {
        render(<PendingInboxFab />)
        const button = screen.getByRole('button')
        expect(button.style.bottom).toContain('5.5rem')
        expect(button.style.bottom).toContain('--app-floating-bottom-offset')
        expect(button.style.right).toContain('safe-area-inset-right')
    })
})
