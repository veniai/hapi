import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { getPendingInboxSessions, PendingInboxFab } from './PendingInboxFab'

const navigateMock = vi.fn()
let selectedSessionId: string | null = null
let sessions: SessionSummary[] = []

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useMatchRoute: () => () => selectedSessionId ? { sessionId: selectedSessionId } : false,
    // FAB renders on a session page (off-list) → useOpenSession picks replace.
    useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
        const loc = { pathname: '/sessions/current' }
        return opts?.select ? opts.select(loc) : loc
    }
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
        attentionRev: 0,
        handledRev: 0,
        ...overrides
    }
}

describe('getPendingInboxSessions', () => {
    it('keeps actionable active sessions and excludes archived, selected, thinking, and background sessions', () => {
        const candidates = [
            makeSession({ id: 'permission', attentionRev: 1, pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'input', attentionRev: 1, pendingRequestKinds: ['input'] }),
            makeSession({ id: 'unread', attentionRev: 1, updatedAt: 200 }),
            makeSession({ id: 'archived', active: false, attentionRev: 1, updatedAt: 200 }),
            makeSession({ id: 'selected', attentionRev: 1, pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'thinking', thinking: true, attentionRev: 1, updatedAt: 200 }),
            makeSession({ id: 'background', attentionRev: 1, backgroundTaskCount: 1, updatedAt: 200 })
        ]

        // Seen revisions are 0 (unseen) for every candidate so the lit check
        // (attentionRev > max(seenRev, handledRev)) is driven by attentionRev.
        const result = getPendingInboxSessions(candidates, 'selected', {})

        expect(result.map(session => session.id)).toEqual(['permission', 'input', 'unread'])
    })
})

describe('PendingInboxFab', () => {
    beforeEach(() => {
        navigateMock.mockClear()
        selectedSessionId = null
        localStorage.clear()
        localStorage.setItem('hapi-lang', 'zh-CN')
        sessions = [
            makeSession({ id: 'first', attentionRev: 1, pendingRequestKinds: ['permission'] }),
            makeSession({ id: 'second', attentionRev: 1, pendingRequestKinds: ['input'] }),
            makeSession({ id: 'closed', active: false, attentionRev: 1, pendingRequestKinds: ['permission'] })
        ]
    })

    it('navigates through the queue instead of getting stuck on the current route', () => {
        const { rerender } = render(<I18nProvider><PendingInboxFab /></I18nProvider>)

        fireEvent.click(screen.getByRole('button', { name: '待处理 2 个会话' }))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'first' },
            replace: true
        })

        selectedSessionId = 'first'
        rerender(<I18nProvider><PendingInboxFab /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: '待处理 1 个会话' }))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'second' },
            replace: true
        })
    })

    it('uses the raised safe-area-aware position', () => {
        render(<I18nProvider><PendingInboxFab /></I18nProvider>)
        const button = screen.getByRole('button')
        expect(button.style.bottom).toContain('5.5rem')
        expect(button.style.bottom).toContain('--app-floating-bottom-offset')
        expect(button.style.right).toContain('safe-area-inset-right')
    })
})
