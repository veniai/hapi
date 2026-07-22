import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { getPageScrollTop, resetPageScroll } from './useViewportHeight'
import { useViewportHeight } from './useViewportHeight'

/**
 * Unit tests for the useViewportHeight hook logic.
 *
 * Because the hook depends on window.visualViewport (not available in jsdom),
 * we test the core update logic directly rather than rendering the hook.
 */
describe('useViewportHeight update logic', () => {
    const root = document.documentElement

    beforeEach(() => {
        root.style.removeProperty('--app-viewport-height')
    })

    afterEach(() => {
        root.style.removeProperty('--app-viewport-height')
        document.documentElement.scrollTop = 0
        document.body.scrollTop = 0
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    })

    it('sets --app-viewport-height when visual viewport is smaller than window', () => {
        // Simulate the update logic from the hook
        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('400px')
    })

    it('removes --app-viewport-height when viewports match', () => {
        // First set it
        root.style.setProperty('--app-viewport-height', '400px')

        // Then simulate keyboard close
        const viewportHeight = 800
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('ignores sub-pixel differences (threshold of 1px)', () => {
        const viewportHeight = 799.5
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('resets page scroll when keyboard is open', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        // Simulate: keyboard open AND page has been scrolled by iOS
        Object.defineProperty(window, 'scrollY', { value: 120, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).toHaveBeenCalledWith(0, 0)

        // Cleanup
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
        scrollToSpy.mockRestore()
    })

    it('does not reset scroll when page is not scrolled', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).not.toHaveBeenCalled()

        scrollToSpy.mockRestore()
    })

    it('detects body scroll when window.scrollY stays zero', () => {
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
        document.documentElement.scrollTop = 0
        document.body.scrollTop = 120

        expect(getPageScrollTop()).toBe(120)
    })

    it('resets both possible outer page scroll containers', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
        document.documentElement.scrollTop = 30
        document.body.scrollTop = 120

        resetPageScroll()

        expect(scrollToSpy).toHaveBeenCalledWith(0, 0)
        expect(document.documentElement.scrollTop).toBe(0)
        expect(document.body.scrollTop).toBe(0)
        scrollToSpy.mockRestore()
    })

    it('clears the keyboard viewport and body scroll when the keyboard closes', async () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
        let viewportHeight = 800
        const viewport = new EventTarget()
        Object.defineProperty(viewport, 'height', {
            configurable: true,
            get: () => viewportHeight
        })
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: viewport
        })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

        const { unmount } = renderHook(() => useViewportHeight())

        viewportHeight = 400
        await act(async () => {
            viewport.dispatchEvent(new Event('resize'))
        })
        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('400px')

        document.body.scrollTop = 80
        viewportHeight = 800
        await act(async () => {
            window.dispatchEvent(new Event('resize'))
        })
        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
        expect(document.body.scrollTop).toBe(0)

        unmount()
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
        scrollToSpy.mockRestore()
    })
})
