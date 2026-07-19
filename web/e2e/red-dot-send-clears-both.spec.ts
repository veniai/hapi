import { expect, test } from '@playwright/test'
import {
    getHapiBaseUrl,
    installHapiAuth,
    readCliAccessToken
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1'

/**
 * web-chat-read-position-sync §6.1/§9.2 — send clears the red dot on BOTH
 * devices. Two browser contexts simulate 电脑 (A) and 手机 (B).
 *
 * Precondition: SESSION_ID must currently show a red dot on both devices
 * (attentionRev > max(localSeenRev, handledRev)). The test then has A send a
 * message and asserts B's dot clears via the hub's handledRev SSE broadcast.
 *
 * HAPI_LIVE-gated because it needs a real hub + a session in a lit state; the
 * underlying state machine is covered by hub/src/sync/attentionRev.test.ts and
 * web/src/lib/sessionAttention.test.ts (the §3.1.3–§3.1.6 matrix). This spec
 * verifies the SSE→browser wiring end-to-end.
 */
test.describe('red-dot: send clears both devices', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 + SESSION_ID=<a lit session> to run')

    test('sending on device A clears the red dot on device B', async ({ browser }) => {
        const baseUrl = getHapiBaseUrl()
        const sessionId = process.env.SESSION_ID
        test.skip(!sessionId, 'SESSION_ID env required (a session currently showing a red dot)')
        const token = readCliAccessToken()

        const ctxA = await browser.newContext()
        const ctxB = await browser.newContext()
        const pageA = await ctxA.newPage()
        const pageB = await ctxB.newPage()
        await installHapiAuth(pageA, baseUrl, token)
        await installHapiAuth(pageB, baseUrl, token)

        await pageA.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded' })
        await pageB.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded' })

        const rowSelector = `[data-session-id="${sessionId}"]`

        const dotVisible = async (page: import('@playwright/test').Page) => {
            // The unread signal is the red title color (rev-driven) on a child
            // of the session row. Absent → handled/cleared.
            const row = page.locator(rowSelector).first()
            const redCount = await row.locator('.text-red-500').count().catch(() => 0)
            return redCount > 0
        }

        // Fail, rather than skip, when the caller supplied the wrong fixture:
        // otherwise the cross-device test can pass without checking device B.
        await expect(pageA.locator(rowSelector).first()).toBeVisible()
        await expect(pageB.locator(rowSelector).first()).toBeVisible()
        await expect.poll(() => dotVisible(pageA), { message: 'session must start lit on A' }).toBe(true)
        await expect.poll(() => dotVisible(pageB), { message: 'session must start lit on B' }).toBe(true)

        // Rule A: A opens the session; B must remain lit.
        await pageA.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' })
        await expect.poll(() => dotVisible(pageB), { message: 'opening on A must not clear B' }).toBe(true)
        await pageA.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded' })
        await expect.poll(() => dotVisible(pageA), { message: 'opening on A must clear A' }).toBe(false)

        // Rule B: a successful send on A clears B.
        await pageA.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' })
        await pageA.waitForSelector('textarea', { timeout: 30_000 })
        await pageA.locator('textarea').first().fill('e2e red-dot probe')
        await pageA.locator('textarea').first().press('Enter')

        // B should converge to no-dot once the handledRev SSE lands.
        await expect.poll(async () => dotVisible(pageB), { timeout: 20_000 }).toBe(false)

        await ctxA.close()
        await ctxB.close()
    })
})
