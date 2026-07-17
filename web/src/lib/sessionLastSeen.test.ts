import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getSessionLastSeenAt, getSessionLastSeenStore, markSessionSeen, SESSION_LAST_SEEN_EVENT } from './sessionLastSeen'

describe('sessionLastSeen', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('stores the latest seen timestamp for a session', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-a', 2500)
        expect(getSessionLastSeenAt('session-a')).toBe(2500)
    })

    it('does not move the watermark backwards', () => {
        markSessionSeen('session-a', 5000)
        markSessionSeen('session-a', 2000)
        expect(getSessionLastSeenAt('session-a')).toBe(5000)
    })

    it('returns one snapshot for list-level last-seen lookups without mutating old snapshots', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-b', 2000)
        const snapshot = getSessionLastSeenStore()

        expect(snapshot).toEqual({ 'session-a': 1000, 'session-b': 2000 })
        markSessionSeen('session-a', 3000)
        expect(snapshot).toEqual({ 'session-a': 1000, 'session-b': 2000 })
        expect(getSessionLastSeenStore()).toEqual({ 'session-a': 3000, 'session-b': 2000 })
    })

    it('ignores localStorage write failures', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })

        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        setItem.mockRestore()
    })

    it('returns zero when localStorage getter throws', () => {
        const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('storage denied')
            },
        })

        expect(getSessionLastSeenAt('session-a')).toBe(0)
        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        if (localStorageDescriptor) {
            Object.defineProperty(window, 'localStorage', localStorageDescriptor)
        }
    })

    it('dispatches SESSION_LAST_SEEN_EVENT when watermark rises (same-tab notify)', () => {
        const handler = vi.fn()
        window.addEventListener(SESSION_LAST_SEEN_EVENT, handler)

        markSessionSeen('session-a', 1000) // 上升 → 派发
        expect(handler).toHaveBeenCalledTimes(1)
        markSessionSeen('session-a', 500) // 不上升 → 不派发
        expect(handler).toHaveBeenCalledTimes(1)
        markSessionSeen('session-a', 2000) // 上升 → 派发
        expect(handler).toHaveBeenCalledTimes(2)

        window.removeEventListener(SESSION_LAST_SEEN_EVENT, handler)
    })
})
