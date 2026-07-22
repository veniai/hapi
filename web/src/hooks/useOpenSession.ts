import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { isSessionsIndexPath } from '@/lib/sessionPath'

/** A sub-page of a session: /sessions/$id/files, /terminal, /file, … (has a 3rd segment). */
const SESSION_SUB_PAGE = /^\/sessions\/[^/]+\//

/**
 * Open a session by id.
 *
 * - **List route** (`/sessions`, `/sessions/`) → `push` (preserve the entry point so system
 *   back reaches the list).
 * - **Session chat page** (`/sessions/$id`) → `replace` (session switch must not stack;
 *   stack stays `[/sessions, B]`, back → list).
 * - **Session sub-page** (`/sessions/$id/files`, …) → two-step navigate: `replace` to
 *   `/sessions` then `push` B. Browser history can't delete the stacked `A` under a
 *   sub-page, so a single `replace` would leave `A` in the stack and back would land on
 *   `A` (the §7 tail). The two steps exploit TanStack Router's synchronous-navigate
 *   chaining (`router-core/src/router.ts:2278` + `commitLocation:2154`): history commits
 *   both entries (stack `[…, /sessions, B]`) but the `/sessions` transition is cancelled
 *   by the second navigate, so the list never renders — no flicker. System back lands on
 *   `/sessions` (list). See spec doc/spec/web-session-back-stack.md §7.
 *
 * NOT a global "≤1 session entry" invariant — the old session `A` stays in the stack
 * under the list; back from the list can still reach it. Core goal (session switch back
 * → list) holds.
 */
export function useOpenSession(): (sessionId: string) => void {
    const navigate = useNavigate()
    const pathname = useLocation({ select: (l) => l.pathname })

    return useCallback((sessionId: string) => {
        if (isSessionsIndexPath(pathname)) {
            navigate({ to: '/sessions/$sessionId', params: { sessionId } })
        } else if (SESSION_SUB_PAGE.test(pathname)) {
            navigate({ to: '/sessions', replace: true })
            navigate({ to: '/sessions/$sessionId', params: { sessionId } })
        } else {
            navigate({ to: '/sessions/$sessionId', params: { sessionId }, replace: true })
        }
    }, [navigate, pathname])
}
