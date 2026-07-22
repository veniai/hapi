import type { AnyRouter } from '@tanstack/react-router'
import { getElementScrollRestorationEntry } from '@tanstack/router-core'
import { freezeMessageWindowForScrollRestoration } from '@/lib/message-window-store'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'

/**
 * Keep a previously rendered message window stable when Router will restore a
 * saved chat viewport for it. This must run before the entry fetch decides
 * whether its response replaces the visible window or becomes pending.
 */
export function freezeRestoredSessionMessageWindow(router: AnyRouter, sessionId: string): boolean {
    const saved = getElementScrollRestorationEntry(router, {
        id: `chat-${sessionId}`,
        getKey: getScrollRestorationKey,
    })
    return saved ? freezeMessageWindowForScrollRestoration(sessionId) : false
}
