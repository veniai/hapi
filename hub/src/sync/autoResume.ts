/**
 * Auto-resume: detect GLM terminal errors from the synthetic messages the hub
 * persists, and (via the caller) schedule a recovery prompt. Two error kinds:
 *  - quota `[1308]`: has a reset time → schedule AT the reset time (§6.1–6.4).
 *  - rate  `[1302]`: no reset time → backoff retry `now + delay` (§6.5).
 * This module is pure helpers + constants — no side effects, no I/O. The
 * scheduling itself reuses the scheduled-send pipeline (see spec §6).
 */

interface SyntheticTextBlock {
    type: 'text'
    text: string
}

interface SyntheticMessage {
    model?: string
    role?: string
    content?: unknown[]
}

// `[1308]` quota: code + reset time `YYYY-MM-DD HH:MM:SS 重置`. Harness-injected
// fixed text (not model-generated), stable to match.
const QUOTA_RESET_PATTERN = /\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/
// `[1302]` rate: code + 速率关键词 (no reset time). Same harness-injected shape.
const RATE_LIMIT_PATTERN = /\[(\d+)\][^\]]*?(?:速率限制|控制请求频率)/

export type QuotaError = { kind: 'quota'; code: string; resetsAtMs: number }
export type RateError = { kind: 'rate'; code: string }
export type SyntheticError = QuotaError | RateError

/** Navigate the synthetic-message envelope safely.
 *  Persisted content shape: { role, content: { type: "output", data: { message: { ... } } } }. */
function navigateMessage(content: unknown): SyntheticMessage | null {
    if (typeof content !== 'object' || content === null) return null
    const outer = content as { content?: unknown }
    if (typeof outer.content !== 'object' || outer.content === null) return null
    const data = (outer.content as { data?: unknown }).data
    if (typeof data !== 'object' || data === null) return null
    const message = (data as { message?: unknown }).message
    if (typeof message !== 'object' || message === null) return null
    return message as SyntheticMessage
}

/** Concatenate text blocks of a synthetic message into a single string. */
function syntheticText(message: SyntheticMessage): string {
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks
        .map((block): string => {
            if (
                block !== null &&
                typeof block === 'object' &&
                (block as SyntheticTextBlock).type === 'text' &&
                typeof (block as SyntheticTextBlock).text === 'string'
            ) {
                return (block as SyntheticTextBlock).text
            }
            return ''
        })
        .join('')
}

/**
 * Identify a GLM terminal error from a hub-persisted agent message.
 * Only harness-injected messages (`model:"<synthetic>"` + `role:"assistant"`)
 * count — agent-authored discussion carries a real model name and is excluded.
 * Quota hit (has reset time) → `{kind:'quota', code, resetsAtMs}`.
 * Rate hit (no reset time, has 速率关键词) → `{kind:'rate', code}`.
 * Otherwise `null` (no auto-resume).
 */
export function classifySyntheticError(content: unknown): SyntheticError | null {
    const message = navigateMessage(content)
    if (!message || message.model !== '<synthetic>' || message.role !== 'assistant') return null

    const text = syntheticText(message)
    if (!text) return null

    // Quota first (more specific — carries a reset time).
    const quota = text.match(QUOTA_RESET_PATTERN)
    if (quota) {
        const parts = quota[2].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
        if (parts) {
            const resetsAtMs = new Date(
                Number.parseInt(parts[1], 10),
                Number.parseInt(parts[2], 10) - 1,
                Number.parseInt(parts[3], 10),
                Number.parseInt(parts[4], 10),
                Number.parseInt(parts[5], 10),
                Number.parseInt(parts[6], 10)
            ).getTime()
            return { kind: 'quota', code: quota[1], resetsAtMs }
        }
    }

    // Rate (no reset time, has 速率关键词).
    const rate = text.match(RATE_LIMIT_PATTERN)
    if (rate) return { kind: 'rate', code: rate[1] }

    return null
}

/** Quota recovery prompt (scheduled at the reset time). */
export const QUOTA_RESUME_PROMPT =
    '（系统自动恢复：API 5 小时限额已重置）临时中断，继续刚才的任务：' +
    '有 skill 必须调 Skill tool 并严格按 skill 流程执行（不得 inline 替代）；' +
    '单步过长可拆分但不跳过；已完成不重做。'

/** Rate recovery prompt (scheduled after a backoff delay). */
export const RATE_RESUME_PROMPT =
    '（系统自动恢复：API 速率限制，已退避等待）临时中断，继续刚才的任务：' +
    '有 skill 必须调 Skill tool 并严格按 skill 流程执行（不得 inline 替代）；' +
    '单步过长可拆分但不跳过；已完成不重做。'

// --- [1302] rate backoff (spec §6.5) ---

/** Base cooldown (CD). User-tuned to 60s. */
export const RATE_BACKOFF_BASE_MS = 60_000
/** Cap: at/above this tier, stop scheduling (silent — session idles for human). */
export const RATE_CAP_TIER = 5
/** Tier counts rate rows within this lookback window. */
export const RATE_TIER_WINDOW_MS = 30 * 60_000
/** localId prefix for rate auto-resume rows (also the count key). */
export const RATE_AUTO_RESUME_PREFIX = 'auto-resume-rate-'

/**
 * Rate backoff delay from the current tier (recent rate auto-resume count).
 * Pure: caller reads the count from DB. Returns `{delayMs}` or `null` if capped.
 * `delay = 60s × 2^tier` → 60/120/240/480/960s; tier ≥ 5 → null (silent stop).
 */
export function computeRateBackoff(recentRateCount: number): { delayMs: number } | null {
    if (!Number.isFinite(recentRateCount) || recentRateCount < 0) return null
    if (recentRateCount >= RATE_CAP_TIER) return null
    return { delayMs: RATE_BACKOFF_BASE_MS * 2 ** recentRateCount }
}

/** Dedup window for the rate localId: `floor(now / 60s)`. Same window → same
 *  localId → addMessage idempotency collapses repeat `[1302]` within 60s. */
export function rateWindow(now: number): number {
    return Math.floor(now / RATE_BACKOFF_BASE_MS)
}
