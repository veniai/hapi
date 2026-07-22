import { expect, test } from '@playwright/test'

type ChatScrollMetrics = {
    windowScrollY: number
    bodyScrollTop: number
    htmlScrollTop: number
    appTop: number
    appBottom: number
    viewportScrollTop: number
    viewportScrollHeight: number
    viewportClientHeight: number
}

declare global {
    interface Window {
        __chatScrollE2E?: {
            send(): void
            alignTarget(): void
            reset(): void
            read(): ChatScrollMetrics
        }
    }
}

test.describe('chat scroll ownership', () => {
    test('send scrolls the chat viewport without moving the outer page', async ({ page }) => {
        await page.goto('/e2e-fixtures/chat-scroll-fixture.html')
        await page.waitForFunction(() => Boolean(window.__chatScrollE2E))

        await page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>('.chat-viewport')
            if (!viewport) throw new Error('chat viewport is missing')
            viewport.scrollTop = 300
        })
        const before = await page.evaluate(() => window.__chatScrollE2E!.read())

        await page.evaluate(() => window.__chatScrollE2E!.send())
        await page.waitForTimeout(100)
        const after = await page.evaluate(() => window.__chatScrollE2E!.read())

        expect(after.windowScrollY).toBe(0)
        expect(after.bodyScrollTop).toBe(0)
        expect(after.htmlScrollTop).toBe(0)
        expect(after.appTop).toBe(0)
        expect(after.appBottom).toBe(760)
        expect(after.viewportScrollTop).toBeGreaterThan(before.viewportScrollTop)
        expect(after.viewportScrollTop).toBe(
            after.viewportScrollHeight - after.viewportClientHeight,
        )
    })

    test('message alignment also stays inside the chat viewport', async ({ page }) => {
        await page.goto('/e2e-fixtures/chat-scroll-fixture.html')
        await page.waitForFunction(() => Boolean(window.__chatScrollE2E))
        await page.evaluate(() => window.__chatScrollE2E!.send())
        await page.waitForTimeout(20)

        await page.evaluate(() => window.__chatScrollE2E!.alignTarget())
        const metrics = await page.evaluate(() => window.__chatScrollE2E!.read())

        expect(metrics.windowScrollY).toBe(0)
        expect(metrics.bodyScrollTop).toBe(0)
        expect(metrics.htmlScrollTop).toBe(0)
        expect(metrics.appTop).toBe(0)
    })
})
