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

    it('pushes from the list route (no replace, so system back reaches the list)', () => {
        pathnameRef.current = '/sessions'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenCalledTimes(1)
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'abc' },
        })
    })

    it('treats /sessions/ (trailing slash) as list too', () => {
        pathnameRef.current = '/sessions/'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenCalledTimes(1)
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'abc' },
        })
    })

    it('replaces from the session chat page (stack stays [list, B])', () => {
        pathnameRef.current = '/sessions/xyz'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenCalledTimes(1)
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'abc' },
            replace: true,
        })
    })

    it('two-step from a sub-page: replace /sessions then push B (back → list, no flicker)', () => {
        pathnameRef.current = '/sessions/xyz/files'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenCalledTimes(2)
        expect(navigateMock).toHaveBeenNthCalledWith(1, {
            to: '/sessions',
            replace: true,
        })
        // second step is a push (no replace) — final target B
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'abc' },
        })
    })

    it('two-step from terminal sub-page too', () => {
        pathnameRef.current = '/sessions/xyz/terminal'
        const { result } = renderHook(() => useOpenSession())
        act(() => result.current('abc'))
        expect(navigateMock).toHaveBeenCalledTimes(2)
        expect(navigateMock).toHaveBeenNthCalledWith(1, { to: '/sessions', replace: true })
    })
})
