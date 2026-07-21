import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    captureScrollAnchor,
    findFirstMessageAfterViewport,
    findFirstNewRenderedMessage,
    getRenderedMessageIds,
    getScrollIntent,
    locateOutlineTargetMessage,
    restoreScrollAnchor,
    shouldRestoreInitialLatest,
} from '@/components/AssistantChat/HappyThread'
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
    it('restores latest only after entry selection and initial messages settle', () => {
        expect(shouldRestoreInitialLatest({
            ready: true,
            pending: true,
            messagesLoaded: true,
            messagesLoading: false
        })).toBe(true)
        expect(shouldRestoreInitialLatest({
            ready: false,
            pending: true,
            messagesLoaded: true,
            messagesLoading: false
        })).toBe(false)
        expect(shouldRestoreInitialLatest({
            ready: true,
            pending: false,
            messagesLoaded: true,
            messagesLoading: false
        })).toBe(false)
        expect(shouldRestoreInitialLatest({
            ready: true,
            pending: true,
            messagesLoaded: true,
            messagesLoading: true
        })).toBe(false)
    })
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

    it('skips optimistic (not-yet-confirmed) messages — they are not durable anchors', () => {
        const viewport = document.createElement('div')
        const optimistic = document.createElement('div')
        const confirmed = document.createElement('div')
        optimistic.id = 'hapi-message-__optimistic__abc'
        confirmed.id = 'hapi-message-11111111-2222-4333-8333-555555555555'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(optimistic, confirmed)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 0, bottom: 500 }))
        vi.spyOn(optimistic, 'getBoundingClientRect').mockReturnValue(rect({ top: 10, bottom: 50 }))
        vi.spyOn(confirmed, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))

        const anchor = captureScrollAnchor(viewport)
        expect(anchor).not.toBeNull()
        expect(anchor?.messageId).toBe('11111111-2222-4333-8333-555555555555')

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

    it('continues to the first already-rendered message below the viewport', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        const visible = document.createElement('div')
        const next = document.createElement('div')
        messages.className = 'happy-thread-messages'
        visible.id = 'visible-message'
        next.id = 'next-message'
        messages.append(visible, next)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 0, bottom: 500 }))
        vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 300 }))
        vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(rect({ top: 520, bottom: 620 }))

        expect(findFirstMessageAfterViewport(viewport)).toBe(next)
        viewport.remove()
    })

    it('finds the first message introduced by a newer page or pending flush', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        const old = document.createElement('div')
        const firstNew = document.createElement('div')
        const secondNew = document.createElement('div')
        messages.className = 'happy-thread-messages'
        old.id = 'old-message'
        messages.append(old)
        viewport.append(messages)
        document.body.append(viewport)

        const previousIds = getRenderedMessageIds(viewport)
        firstNew.id = 'first-new-message'
        secondNew.id = 'second-new-message'
        messages.append(firstNew, secondNew)

        expect(findFirstNewRenderedMessage(viewport, previousIds)).toBe(firstNew)
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
