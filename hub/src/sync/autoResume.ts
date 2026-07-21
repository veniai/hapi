/**
 * Auto-resume: detect GLM quota terminal errors from the synthetic messages the
 * hub persists, and (via the caller) schedule a recovery prompt at the reset
 * time. This module is pure functions + a constant — no side effects, no I/O.
 * The scheduling itself reuses the scheduled-send pipeline (see spec §6).
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

// `[1308]` quota code + reset time `YYYY-MM-DD HH:MM:SS 重置`. The harness/GLM
// injects this as fixed text (not model-generated), so it is stable to match.
const QUOTA_RESET_PATTERN = /\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/

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

/**
 * Identify a GLM quota terminal error from a hub-persisted agent message.
 * Only harness-injected messages (`model:"<synthetic>"` + `role:"assistant"`)
 * count — agent-authored discussion of the error carries a real model name and
 * is excluded. Quota hit → `{ code, resetsAtMs }`; otherwise `null` (no-op).
 */
export function classifySyntheticQuotaError(content: unknown): {
    code: string
    resetsAtMs: number
} | null {
    const message = navigateMessage(content)
    if (!message || message.model !== '<synthetic>' || message.role !== 'assistant') return null

    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
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
    if (!text) return null

    const match = text.match(QUOTA_RESET_PATTERN)
    if (!match) return null // transient ([1302]/529, no reset time) or unknown → no-op
    const parts = match[2].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
    if (!parts) return null
    // Parse as local time (hub process TZ). Assumes hub TZ == GLM server TZ (spec §9.7).
    const resetsAtMs = new Date(
        Number.parseInt(parts[1], 10),
        Number.parseInt(parts[2], 10) - 1,
        Number.parseInt(parts[3], 10),
        Number.parseInt(parts[4], 10),
        Number.parseInt(parts[5], 10),
        Number.parseInt(parts[6], 10)
    ).getTime()
    return { code: match[1], resetsAtMs }
}

/** Recovery prompt scheduled at the quota reset time. `sentFrom:'system'` lets
 *  web badge it later; for now the prefix self-labels "系统自动恢复". */
export const QUOTA_RESUME_PROMPT =
    '（系统自动恢复：API 5 小时限额已重置）临时中断，继续刚才的任务：' +
    '有 skill 必须调 Skill tool 并严格按 skill 流程执行（不得 inline 替代）；' +
    '单步过长可拆分但不跳过；已完成不重做。'
