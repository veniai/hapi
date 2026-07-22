import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted keeps navigateMock/pathnameRef in the same hoisted scope as the
// vi.mock factory so the factory closure reads live values.
const { navigateMock, pathnameRef } = vi.hoisted(() => ({
    navigateMock: vi.fn(),
    pathnameRef: { current: '/sessions' as string },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    // useOpenSession calls useLocation({ select: (l) => l.pathname }), so honor select.
    useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
        const loc = { pathname: pathnameRef.current }
        return opts?.select ? opts.select(loc) : loc
    },
}))

import { useOpenSession } from './useOpenSession'

describe('useOpenSession', () => {
    beforeEach(() => {
        navigateMock.mockClear()
    })

    it.each([
        // On the list → push (replace: false) so system back reaches the list
        ['/sessions', false],
        ['/sessions/', false],
        // '/' is the root, not the sessions index; it redirects to /sessions
        // instantly so useOpenSession never fires here. Off-list → replace.
        ['/', true],
        // Off the list → replace (no stacking on session switch)
        ['/sessions/new', true],
        ['/sessions/abc', true],
        ['/sessions/abc/files', true],
    ])('pathname %s → replace=%s', (pathname, expectedReplace) => {
        pathnameRef.current = pathname
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'abc' },
            replace: expectedReplace,
        })
    })

    it('passes the sessionId through to navigate', () => {
        pathnameRef.current = '/sessions'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('xyz-123'))
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'xyz-123' },
            replace: false,
        })
    })
})
