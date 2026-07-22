import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { isSessionsIndexPath } from '@/lib/sessionPath'

/**
 * Open a session by id.
 *
 * Push when on the list route (preserve the entry point so system back lands
 * on the list); replace otherwise — a session→session switch must not stack a
 * new entry, or system back would walk `[/sessions, A, B] → A` instead of the
 * list (the bug in spec doc/spec/web-session-back-stack.md §2.3).
 *
 * Goal: system back from the chat page after a chat-initiated cross-session
 * switch always returns to the list. This is NOT a global "≤1 session entry"
 * invariant — sub-page switches and in-app back can still leave residue
 * (spec §7.1).
 */
export function useOpenSession(): (sessionId: string) => void {
    const navigate = useNavigate()
    const pathname = useLocation({ select: (l) => l.pathname })

    return useCallback((sessionId: string) => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: !isSessionsIndexPath(pathname),
        })
    }, [navigate, pathname])
}
