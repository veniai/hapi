import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchCodexQuota } from './codexQuota'

describe('fetchCodexQuota', () => {
    const originalCodexHome = process.env.CODEX_HOME
    const originalFetch = globalThis.fetch

    afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
        globalThis.fetch = originalFetch
    })

    it('keeps the weekly window and reads reset credits', async () => {
        const codexHome = await mkdtemp(join(tmpdir(), 'hapi-codex-quota-'))
        process.env.CODEX_HOME = codexHome
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: 'access-token', account_id: 'account-id' }
        }))
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                rate_limit: {
                    primary_window: {
                        used_percent: 7,
                        limit_window_seconds: 604800,
                        reset_after_seconds: 100,
                        reset_at: 200
                    },
                    secondary_window: {
                        used_percent: 12,
                        limit_window_seconds: 18000,
                        reset_after_seconds: 300,
                        reset_at: 400
                    }
                }
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                available_count: 2,
                total_earned_count: 3,
                credits: [{ status: 'available', expires_at: '2026-07-30T00:00:00Z' }]
            }), { status: 200 })) as unknown as typeof fetch

        await expect(fetchCodexQuota(123)).resolves.toEqual({
            status: 'ok',
            collectedAt: 123,
            weekly: {
                usedPercent: 7,
                windowSeconds: 604800,
                resetAt: 200,
                resetAfterSeconds: 100
            },
            resetCredits: {
                status: 'ok',
                availableCount: 2,
                totalEarnedCount: 3,
                nextExpiresAt: Date.parse('2026-07-30T00:00:00Z')
            }
        })

        expect(fetch).toHaveBeenCalledWith(
            'https://chatgpt.com/backend-api/wham/usage',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer access-token',
                    'Chatgpt-Account-Id': 'account-id'
                })
            })
        )
        expect(fetch).toHaveBeenCalledWith(
            'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer access-token',
                    'OpenAI-Beta': 'codex-1',
                    originator: 'Codex Desktop'
                })
            })
        )
        await rm(codexHome, { recursive: true, force: true })
    })

    it('returns an error state without retaining a failed response', async () => {
        const codexHome = await mkdtemp(join(tmpdir(), 'hapi-codex-quota-'))
        process.env.CODEX_HOME = codexHome
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: 'access-token' }
        }))
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch

        await expect(fetchCodexQuota(456)).resolves.toEqual({
            status: 'error',
            collectedAt: 456
        })
        await rm(codexHome, { recursive: true, force: true })
    })

    it('returns null when no ChatGPT auth is configured', async () => {
        const codexHome = await mkdtemp(join(tmpdir(), 'hapi-codex-quota-'))
        process.env.CODEX_HOME = codexHome
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'apiKey' }))

        await expect(fetchCodexQuota(789)).resolves.toBeNull()
        await rm(codexHome, { recursive: true, force: true })
    })
})
