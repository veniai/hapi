import { expect, test } from '@playwright/test'
import {
    getHapiBaseUrl,
    getMermaidTestSessionId,
    installHapiAuth,
    readCliAccessToken,
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1'

/**
 * spec §7.2 手测"看过的 session 切回不跑顶"的自动化版。
 * 真浏览器（Playwright）验：滚到一条 agent 消息 → 刷新 → 应落回该消息附近。
 * 这是 jsdom 测不到的 scroll 行为，必须真浏览器。
 */
test.describe('read-position: refresh lands on last-read message', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    test('refresh lands on the agent message scrolled to before reload', async ({ page }) => {
        console.log('[e2e] HAPI_LIVE =', JSON.stringify(process.env.HAPI_LIVE), '→ liveEnabled =', liveEnabled)
        const baseUrl = getHapiBaseUrl()
        const sessionId = process.env.SESSION_ID ?? getMermaidTestSessionId()
        const token = readCliAccessToken()
        await installHapiAuth(page, baseUrl, token)

        await page.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForSelector('[data-hapi-role="agent"]', { timeout: 30_000 })
        await page.waitForTimeout(2500) // let messages render + initial scroll settle

        const agentMessages = page.locator('[data-hapi-role="agent"]')
        const count = await agentMessages.count()
        console.log('[e2e] DOM agent message count:', count)
        test.skip(count < 1, 'need at least 1 agent message')

        // scroll to the last agent message in the rendered window
        const target = agentMessages.nth(count - 1)
        await target.scrollIntoViewIfNeeded()
        await page.waitForTimeout(1200) // captureScrollAnchor writes saved; reporter may fire

        const targetDomId = await target.getAttribute('id')
        expect(targetDomId, 'target agent message must have a DOM id').toBeTruthy()
        const targetMessageId = targetDomId!.startsWith('hapi-message-')
            ? targetDomId!.slice('hapi-message-'.length)
            : targetDomId
        // optimistic ids are temporary — skip if we landed on one
        test.skip(targetMessageId.startsWith('__optimistic__'), 'landed on an optimistic id; pick another session')

        // reload triggers pagehide (reporter reports last-read) + re-entry (locator)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForSelector('[data-hapi-role="agent"]', { timeout: 30_000 })
        await page.waitForTimeout(6000) // locator load + restoreScrollAnchor settle

        // verify the target message is back in the viewport after refresh
        const targetEl = page.locator(`[id="${targetDomId}"]`)
        await expect(targetEl, 'target message should still be in the DOM after refresh').toBeAttached({ timeout: 15_000 })
        const inViewport = await targetEl.evaluate((el) => {
            const rect = el.getBoundingClientRect()
            const vh = window.innerHeight
            const scrollers = [...document.querySelectorAll('*')].filter(
                (e) => (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 80,
            ) as HTMLElement[]
            scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)
            const viewport = scrollers[0]
            // @ts-expect-error debug log
            window.__e2eDebug = {
                rectTop: Math.round(rect.top),
                rectBottom: Math.round(rect.bottom),
                vh,
                scrollTop: viewport?.scrollTop,
                scrollHeight: viewport?.scrollHeight,
                clientHeight: viewport?.clientHeight,
            }
            return rect.top > -120 && rect.top < vh - 40
        })
        const debug = await page.evaluate(() => (window as unknown as { __e2eDebug?: unknown }).__e2eDebug)
        console.log('[e2e] after-refresh scroll state:', JSON.stringify(debug))
        expect(
            inViewport,
            `target agent message ${targetDomId} should be in viewport after refresh (got scrolled back to it)`,
        ).toBe(true)
    })
})
