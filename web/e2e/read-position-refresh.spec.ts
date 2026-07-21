import { expect, test } from '@playwright/test'
import {
    getHapiBaseUrl,
    getMermaidTestSessionId,
    installHapiAuth,
    readCliAccessToken,
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1'

async function readFirstVisible(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const v = [...document.querySelectorAll('.app-scroll-y')].sort(
            (a, b) => b.scrollHeight - a.scrollHeight,
        )[0] as HTMLElement
        const vv = v.getBoundingClientRect()
        const msgs = [...document.querySelectorAll('.happy-thread-messages > [id]')] as HTMLElement[]
        let first = ''
        for (const m of msgs) {
            const r = m.getBoundingClientRect()
            if (r.bottom > vv.top + 4 && r.top < vv.bottom - 4) {
                first = m.id
                break
            }
        }
        return { first, scrollTop: v?.scrollTop ?? 0, scrollHeight: v?.scrollHeight ?? 0 }
    })
}

test.describe('read-position refresh', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    test('reload lands back on the message you were on', async ({ page }) => {
        const baseUrl = getHapiBaseUrl()
        const sessionId = process.env.SESSION_ID ?? getMermaidTestSessionId()
        await installHapiAuth(page, baseUrl, readCliAccessToken())
        await page.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForSelector('.happy-thread-messages > [id]', { timeout: 30_000 })
        await page.waitForTimeout(3000)

        // scroll to middle of the thread
        await page.evaluate(() => {
            const v = [...document.querySelectorAll('.app-scroll-y')].sort(
                (a, b) => b.scrollHeight - a.scrollHeight,
            )[0] as HTMLElement
            if (v) v.scrollTop = Math.floor(v.scrollHeight / 2)
        })
        await page.waitForTimeout(1500)
        const before = await readFirstVisible(page)
        test.skip(!before.first, 'no visible message')

        // clear SW + cache so reload picks up the freshly deployed dist
        await page.evaluate(async () => {
            try {
                if (window.caches) {
                    const keys = await caches.keys()
                    await Promise.all(keys.map((k) => caches.delete(k)))
                }
                const regs = await navigator.serviceWorker.getRegistrations()
                await Promise.all(regs.map((r) => r.unregister()))
            } catch {
                /* ignore */
            }
        })
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForSelector('.happy-thread-messages > [id]', { timeout: 30_000 })
        await page.waitForTimeout(9000)
        const after = await readFirstVisible(page)

        expect(after.first, 'reload should land back on the same first-visible message').toBe(before.first)
    })
})
