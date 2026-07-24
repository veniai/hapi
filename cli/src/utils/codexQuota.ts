import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexQuotaSchema, type CodexQuota } from '@hapi/protocol/schemas'

const CODEX_QUOTA_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CODEX_QUOTA_TIMEOUT_MS = 15_000

type CodexAuth = {
    auth_mode?: unknown
    OPENAI_API_KEY?: unknown
    tokens?: {
        access_token?: unknown
        account_id?: unknown
    }
}

type UsageWindow = {
    used_percent?: unknown
    limit_window_seconds?: unknown
    reset_after_seconds?: unknown
    reset_at?: unknown
}

type UsageResponse = {
    rate_limit?: {
        primary_window?: UsageWindow | null
        secondary_window?: UsageWindow | null
    }
}

type ResetCreditsResponse = {
    available_count?: unknown
    total_earned_count?: unknown
    credits?: unknown
}

function getCodexHome(): string {
    return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

function parseUsageWindow(value: UsageWindow | null | undefined): CodexQuota['weekly'] {
    if (!value || typeof value !== 'object') {
        return null
    }

    const usedPercent = typeof value.used_percent === 'number' ? value.used_percent : NaN
    const windowSeconds = typeof value.limit_window_seconds === 'number' ? value.limit_window_seconds : NaN
    const resetAfterSeconds = typeof value.reset_after_seconds === 'number' ? value.reset_after_seconds : NaN
    const resetAt = typeof value.reset_at === 'number' ? value.reset_at : NaN
    if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds)
        || !Number.isFinite(resetAfterSeconds) || !Number.isFinite(resetAt)) {
        return null
    }

    return {
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        windowSeconds,
        resetAt,
        resetAfterSeconds
    }
}

function findWindow(
    windows: Array<UsageWindow | null | undefined>,
    seconds: number
): CodexQuota['weekly'] {
    const value = windows
        .map((window) => parseUsageWindow(window))
        .find((window) => window?.windowSeconds === seconds)
    return value ?? null
}

function buildQuota(usage: UsageResponse, collectedAt: number): CodexQuota {
    const primary = usage.rate_limit?.primary_window
    const secondary = usage.rate_limit?.secondary_window
    const windows = [primary, secondary]
    const parsed: CodexQuota = {
        status: 'ok',
        collectedAt,
        weekly: findWindow(windows, 7 * 24 * 60 * 60)
    }
    return CodexQuotaSchema.parse(parsed)
}

function parseResetCredits(value: ResetCreditsResponse): NonNullable<CodexQuota['resetCredits']> {
    const availableCount = typeof value.available_count === 'number' ? value.available_count : NaN
    const totalEarnedCount = typeof value.total_earned_count === 'number' ? value.total_earned_count : NaN
    if (!Number.isInteger(availableCount) || availableCount < 0
        || !Number.isInteger(totalEarnedCount) || totalEarnedCount < 0
        || !Array.isArray(value.credits)) {
        return { status: 'error' }
    }

    const expiryTimes = value.credits
        .filter((credit): credit is Record<string, unknown> => Boolean(credit && typeof credit === 'object'))
        .filter((credit) => credit.status === undefined || credit.status === 'available')
        .map((credit) => typeof credit.expires_at === 'string' ? Date.parse(credit.expires_at) : NaN)
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)

    return {
        status: 'ok',
        availableCount,
        totalEarnedCount,
        nextExpiresAt: expiryTimes.length > 0 ? Math.min(...expiryTimes) : null
    }
}

async function readCodexAuth(): Promise<CodexAuth | null> {
    try {
        const raw = await readFile(join(getCodexHome(), 'auth.json'), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null
        }
        return parsed as CodexAuth
    } catch {
        return null
    }
}

export async function fetchCodexQuota(now: number = Date.now()): Promise<CodexQuota | null> {
    const auth = await readCodexAuth()
    const accessToken = typeof auth?.tokens?.access_token === 'string' ? auth.tokens.access_token : ''
    if (auth?.auth_mode !== 'chatgpt' || !accessToken) {
        return null
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex_cli_rs/0.145.0',
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop'
    }
    if (typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id.length > 0) {
        headers['Chatgpt-Account-Id'] = auth.tokens.account_id
    }

    try {
        const response = await fetch(CODEX_QUOTA_URL, {
            headers,
            signal: AbortSignal.timeout(CODEX_QUOTA_TIMEOUT_MS)
        })
        if (!response.ok) {
            throw new Error(`Codex quota request failed with HTTP ${response.status}`)
        }
        const usage = await response.json() as UsageResponse
        const quota = buildQuota(usage, now)
        let resetCredits: NonNullable<CodexQuota['resetCredits']>
        try {
            const creditsResponse = await fetch(CODEX_RESET_CREDITS_URL, {
                headers,
                signal: AbortSignal.timeout(CODEX_QUOTA_TIMEOUT_MS)
            })
            if (!creditsResponse.ok) throw new Error(`Codex reset credits request failed with HTTP ${creditsResponse.status}`)
            resetCredits = parseResetCredits(await creditsResponse.json() as ResetCreditsResponse)
        } catch {
            resetCredits = { status: 'error' }
        }
        return CodexQuotaSchema.parse({ ...quota, resetCredits })
    } catch {
        return CodexQuotaSchema.parse({ status: 'error', collectedAt: now })
    }
}
