import { expect, test } from '@playwright/test'
import {
    getHapiBaseUrl,
    installHapiAuth,
    readCliAccessToken,
} from './helpers/hapi-live'

const sessionId = process.env.SESSION_ID
const liveEnabled = process.env.HAPI_LIVE === '1' && Boolean(sessionId)

type SavedPosition = {
    anchor?: { id: string; topOffset: number }
}

async function readAnchorOffset(page: import('@playwright/test').Page, anchorId: string) {
    return await page.evaluate((id) => {
        const target = document.getElementById(id)
        const viewport = [...document.querySelectorAll<HTMLElement>('.app-scroll-y')]
            .find((candidate) => candidate.contains(target))
        if (!target || !viewport) return null
        return target.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    }, anchorId)
}

test.describe('chat entry position — live browser regression', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 and SESSION_ID=<session with lastReadMessageId>')

    test('locator settles at top and reload restores the exact local offset', async ({ page, request }) => {
        const id = sessionId!
        const baseUrl = getHapiBaseUrl()
        const accessToken = readCliAccessToken()
        const auth = await request.post(`${baseUrl}/api/auth`, {
            data: { accessToken }
        })
        expect(auth.ok()).toBe(true)
        const { token } = await auth.json() as { token: string }
        const detail = await request.get(`${baseUrl}/api/sessions/${id}`, {
            headers: { authorization: `Bearer ${token}` }
        })
        expect(detail.ok()).toBe(true)
        const payload = await detail.json() as { session: { lastReadMessageId?: string | null } }
        const targetMessageId = payload.session.lastReadMessageId
        expect(targetMessageId, 'fixture must have a shared read anchor').toBeTruthy()
        const targetAnchorId = `hapi-message-${targetMessageId}`

        await page.route('**/api/sessions/*/read-position', (route) => route.abort())
        await installHapiAuth(page, baseUrl, accessToken)
        await page.goto(`${baseUrl}/sessions/${id}`, { waitUntil: 'domcontentloaded' })
        await page.locator(`[id="${targetAnchorId}"]`).waitFor({ state: 'attached' })
        await page.waitForTimeout(3_000)

        const locatorOffset = await readAnchorOffset(page, targetAnchorId)
        expect(locatorOffset).not.toBeNull()
        expect(Math.abs(locatorOffset!)).toBeLessThanOrEqual(1)

        await page.evaluate(() => {
            const viewport = [...document.querySelectorAll<HTMLElement>('.app-scroll-y')]
                .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
            viewport.scrollTop += 257
        })
        await page.waitForTimeout(500)
        const saved = await page.evaluate((sid) => {
            const raw = localStorage.getItem(`hapi.chat-scroll.v2.${sid}`)
            return raw ? JSON.parse(raw) as SavedPosition : null
        }, id)
        expect(saved?.anchor).toBeTruthy()
        const beforeReload = await readAnchorOffset(page, saved!.anchor!.id)
        expect(Math.abs(beforeReload! - saved!.anchor!.topOffset)).toBeLessThanOrEqual(1)

        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator(`[id="${saved!.anchor!.id}"]`).waitFor({ state: 'attached' })
        await page.waitForTimeout(3_000)
        const afterReload = await readAnchorOffset(page, saved!.anchor!.id)
        expect(afterReload).not.toBeNull()
        expect(Math.abs(afterReload! - saved!.anchor!.topOffset)).toBeLessThanOrEqual(1)
    })
})
