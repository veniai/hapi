import { expect, test, type Page } from '@playwright/test'

type SessionIds = {
    sessionA: string
    sessionB: string
}

async function getSessionIds(page: Page): Promise<SessionIds> {
    return await page.evaluate(() => window.__sessionScrollE2E!)
}

async function firstVisibleMessageId(page: Page): Promise<string> {
    return await page.evaluate(() => {
        const viewport = document.querySelector('[data-testid="message-viewport"]') as HTMLElement
        const bounds = viewport.getBoundingClientRect()
        const row = [...document.querySelectorAll('[data-testid="message-row"]')]
            .find((element) => {
                const rect = element.getBoundingClientRect()
                return rect.bottom > bounds.top && rect.top < bounds.bottom
            }) as HTMLElement | undefined
        return row?.dataset.messageId ?? ''
    })
}

async function waitForLoadedThread(page: Page, sessionId: string): Promise<void> {
    const thread = page.getByTestId('thread')
    await expect(thread).toHaveAttribute('data-session', sessionId)
    await expect(thread).toHaveAttribute('data-loaded', 'true')
}

test.describe('session scroll restoration', () => {
    test('keeps the restored long-session window stable while staging the entry refresh', async ({ page }, testInfo) => {
        await page.goto(`/e2e-fixtures/session-scroll-restoration-fixture.html?run=${encodeURIComponent(testInfo.testId)}`)
        const { sessionA, sessionB } = await getSessionIds(page)
        await waitForLoadedThread(page, sessionA)
        await expect(page.getByTestId('message-row')).toHaveCount(400)

        await page.getByTestId('message-viewport').evaluate((element) => {
            const viewport = element as HTMLElement
            viewport.scrollTop = viewport.scrollHeight
            viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        const before = await firstVisibleMessageId(page)
        expect(before).toContain(`${sessionA}-message-`)

        await page.getByTestId('open-b').click()
        await waitForLoadedThread(page, sessionB)

        await page.getByTestId('open-a').click()
        await waitForLoadedThread(page, sessionA)

        await expect(page.getByTestId('pending-count')).toHaveText('50')
        await expect(page.getByTestId('message-row')).toHaveCount(400)
        await expect.poll(() => firstVisibleMessageId(page)).toBe(before)
        await expect(page.locator(`[data-message-id="${sessionA}-message-400"]`)).toHaveCount(0)
    })

    test('keeps a cold session on the existing latest-and-bottom path', async ({ page }, testInfo) => {
        await page.goto(`/e2e-fixtures/session-scroll-restoration-fixture.html?run=${encodeURIComponent(testInfo.testId)}`)
        const { sessionB } = await getSessionIds(page)

        await page.getByTestId('open-b').click()
        await waitForLoadedThread(page, sessionB)
        await expect(page.getByTestId('message-row')).toHaveCount(50)
        await expect.poll(async () => await page.getByTestId('message-viewport').evaluate((element) => {
            const viewport = element as HTMLElement
            return viewport.scrollTop === viewport.scrollHeight - viewport.clientHeight
        })).toBe(true)
        await expect(page.locator(`[data-message-id="${sessionB}-message-49"]`)).toBeVisible()
    })
})
