import { useEffect } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'

export function getPageScrollTop(): number {
    return Math.max(
        window.scrollY,
        document.documentElement.scrollTop,
        document.body?.scrollTop ?? 0
    )
}

export function resetPageScroll(): void {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    if (document.body) {
        document.body.scrollTop = 0
    }
}

/**
 * Sets a CSS custom property `--app-viewport-height` on <html> that tracks the
 * visual viewport height. This is a fallback for browsers that do not support
 * the `interactive-widget=resizes-content` viewport meta attribute — on those
 * browsers `100dvh` does NOT shrink when the virtual keyboard opens, so the
 * composer input is hidden behind the keyboard.
 *
 * The hook listens to `window.visualViewport.resize` and writes the viewport
 * height into the CSS variable. The CSS height chain is:
 *   var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh))
 *
 * Skipped in Telegram Mini Apps (Telegram SDK provides its own height variable).
 */
export function useViewportHeight(): void {
    useEffect(() => {
        // Telegram Mini App has its own viewport management via --tg-viewport-stable-height
        if (isTelegramApp()) return

        const viewport = window.visualViewport
        if (!viewport) return

        const root = document.documentElement
        let keyboardWasOpen = false

        function update() {
            if (!viewport) return
            // Only apply when the visual viewport is meaningfully smaller than
            // the window (keyboard is open). A small threshold (1px) avoids
            // false positives from sub-pixel rounding.
            const diff = window.innerHeight - viewport.height
            if (diff > 1) {
                keyboardWasOpen = true
                root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
                // On iOS PWA (black-translucent status bar + viewport-fit=cover),
                // the browser scrolls the page upward when the keyboard opens to
                // keep the focused input visible. This pushes the header behind
                // the iOS status bar. Reset the page scroll so the app stays
                // pinned to the top — the inner flex layout already handles
                // keeping the composer visible.
                if (getPageScrollTop() > 0) {
                    resetPageScroll()
                }
            } else {
                root.style.removeProperty('--app-viewport-height')
                if (keyboardWasOpen && getPageScrollTop() > 0) {
                    resetPageScroll()
                }
                keyboardWasOpen = false
            }
        }

        update()
        viewport.addEventListener('resize', update)
        viewport.addEventListener('scroll', update)
        window.addEventListener('resize', update)

        return () => {
            viewport.removeEventListener('resize', update)
            viewport.removeEventListener('scroll', update)
            window.removeEventListener('resize', update)
            root.style.removeProperty('--app-viewport-height')
        }
    }, [])
}
