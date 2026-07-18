import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    captureScrollAnchor,
    getScrollIntent,
    locateOutlineTargetMessage,
    resolveSavedScrollPosition,
    restoreScrollAnchor,
} from '@/components/AssistantChat/HappyThread'
import {
    gcChatScrollPositions,
    readChatScrollPosition,
    writeChatScrollPosition
} from '@/lib/chat-scroll-store'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]

function rect(values: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>): DOMRect {
    return {
        left: 0,
        right: 300,
        width: 300,
        height: values.bottom - values.top,
        x: 0,
        y: values.top,
        toJSON: () => ({}),
        ...values
    } as DOMRect
}

function renderPanel(props: Partial<ComponentProps<typeof ConversationOutlinePanel>> = {}) {
    return render(
        <I18nProvider>
            <ConversationOutlinePanel
                title="project"
                items={outlineItems}
                hasMoreMessages={false}
                isLoadingMoreMessages={false}
                onLoadMore={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('ConversationOutlinePanel', () => {
    it('renders outline items and selects an item', () => {
        const onSelect = vi.fn()
        renderPanel({ onSelect })

        fireEvent.click(screen.getByText('Implement the panel'))

        expect(onSelect).toHaveBeenCalledWith(outlineItems[0])
    })

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('renders an empty state', () => {
        renderPanel({ items: [] })

        expect(screen.getByText('No outline items in loaded messages')).toBeInTheDocument()
    })
})

describe('scroll anchor helpers', () => {
    it('captures the first visible message relative to the viewport', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        viewport.className = 'viewport'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'second-message',
            topOffset: 20,
            messageId: 'second-message'
        })

        viewport.remove()
    })

    it('parses raw messageId from hapi-message-* DOM ids for cross-device sync', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'hapi-message-11111111-2222-3333-4444-555555555555'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(message)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 0, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))

        const anchor = captureScrollAnchor(viewport)
        expect(anchor).not.toBeNull()
        expect(anchor?.id).toBe('hapi-message-11111111-2222-3333-4444-555555555555')
        expect(anchor?.messageId).toBe('11111111-2222-3333-4444-555555555555')

        viewport.remove()
    })

    it('treats upward motion near the bottom as manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 690,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 12,
            isNearBottom: true,
            isScrollingUp: true
        })
    })

    it('does not classify downward movement as upward manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 0,
            isNearBottom: true,
            isScrollingUp: false
        })
    })

    it('restores the captured message to the same viewport offset', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 260 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', topOffset: 30 })).toBe(true)
        expect(viewport.scrollTop).toBe(250)

        viewport.remove()
    })
})

describe('outline target loading', () => {
    it('loads older messages through the scroll-preserving wrapper until the target appears', async () => {
        const loadOlderPreservingScroll = vi.fn<() => Promise<boolean>>()
        let loadCount = 0
        loadOlderPreservingScroll.mockImplementation(async () => {
            loadCount += 1
            return true
        })

        const findTarget = vi.fn((anchorId: string) => {
            if (anchorId !== 'hapi-message-user-text:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user-text:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })
})

describe('chat scroll persistence', () => {
    it('stores a durable message anchor and rounded fallback position per session', () => {
        localStorage.clear()
        writeChatScrollPosition('session-a', {
            scrollTop: 123.6,
            anchor: { id: 'message-7', topOffset: 18.4 }
        })

        expect(readChatScrollPosition('session-a')).toMatchObject({
            scrollTop: 124,
            anchor: { id: 'message-7', topOffset: 18 }
        })
    })

    it('round-trips anchor messageId + capture timestamp for the locator target pick', () => {
        localStorage.clear()
        const before = Date.now()
        writeChatScrollPosition('session-pos', {
            scrollTop: 50,
            anchor: { id: 'hapi-message-msg-9', topOffset: 10, messageId: 'msg-9' }
        })
        const after = Date.now()

        const read = readChatScrollPosition('session-pos')
        expect(read).not.toBeNull()
        expect(read?.anchor?.messageId).toBe('msg-9')
        expect(read?.capturedAt).toBeGreaterThanOrEqual(before)
        expect(read?.capturedAt).toBeLessThanOrEqual(after)
    })

    it('clearChatScrollPosition drops the saved anchor', async () => {
        const { clearChatScrollPosition } = await import('@/lib/chat-scroll-store')
        localStorage.clear()
        writeChatScrollPosition('session-clear', { scrollTop: 10, anchor: null })
        expect(readChatScrollPosition('session-clear')).not.toBeNull()
        clearChatScrollPosition('session-clear')
        expect(readChatScrollPosition('session-clear')).toBeNull()
    })

    it('migrates the legacy session-scoped numeric position', () => {
        localStorage.clear()
        sessionStorage.setItem('hapi.chat-scroll.v1.legacy', '321')

        expect(readChatScrollPosition('legacy')).toEqual({ scrollTop: 321, anchor: null })
    })

    it('garbage-collects durable positions only for deleted sessions', () => {
        localStorage.clear()
        writeChatScrollPosition('keep', { scrollTop: 10, anchor: null })
        writeChatScrollPosition('remove', { scrollTop: 20, anchor: null })

        expect(gcChatScrollPositions(new Set(['keep']))).toBe(1)
        expect(readChatScrollPosition('keep')).toMatchObject({ scrollTop: 10, anchor: null })
        expect(readChatScrollPosition('remove')).toBeNull()
    })

    it('keeps the original target pending while async content is too short', () => {
        expect(resolveSavedScrollPosition(2000, 200, false)).toEqual({
            scrollTop: 200,
            pendingScrollTop: 2000
        })
    })

    it('releases the target only after the full saved position is reachable', () => {
        expect(resolveSavedScrollPosition(2000, 2400, false)).toEqual({
            scrollTop: 2000,
            pendingScrollTop: null
        })
    })
})
