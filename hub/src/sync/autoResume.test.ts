import { describe, expect, it } from 'bun:test'
import {
    classifySyntheticError,
    QUOTA_RESUME_PROMPT,
    RATE_RESUME_PROMPT,
    RATE_BACKOFF_BASE_MS,
    computeRateBackoff,
    rateWindow,
} from './autoResume'

/** Build a hub-persisted synthetic-message envelope. */
function syntheticContent(text: string, model = '<synthetic>'): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                message: {
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [{ type: 'text', text }]
                }
            }
        }
    }
}

const QUOTA_1308_TEXT =
    'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。][20260717...'
const RATE_1302_TEXT =
    'API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率][20260721224854f77f3391b1f94b3a]'

describe('classifySyntheticError', () => {
    it('[1308] quota → {kind:quota, code, resetsAtMs} + reset time parsed (full fields)', () => {
        const r = classifySyntheticError(syntheticContent(QUOTA_1308_TEXT))
        expect(r).not.toBeNull()
        if (r === null || r.kind !== 'quota') throw new Error('expected [1308] quota error')
        expect(r.code).toBe('1308')
        // Full-field reset-time assertion (spec §8.1): catches minute/second parse
        // errors AND UTC-misinterpretation.
        const d = new Date(r.resetsAtMs)
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
            .toEqual([2026, 6, 17, 16, 1, 19])
    })

    it('[1302] rate → {kind:rate, code} (no reset time)', () => {
        expect(classifySyntheticError(syntheticContent(RATE_1302_TEXT))).toEqual({ kind: 'rate', code: '1302' })
    })

    it('returns null for agent-authored discussion of [1308] (real model name)', () => {
        expect(classifySyntheticError(syntheticContent(QUOTA_1308_TEXT, 'glm-5.2'))).toBeNull()
    })

    it('returns null for agent-authored discussion of [1302] (real model name)', () => {
        expect(classifySyntheticError(syntheticContent(RATE_1302_TEXT, 'glm-5.2'))).toBeNull()
    })

    it('returns null for a tool_result envelope (role:user, no model)', () => {
        expect(
            classifySyntheticError({
                role: 'user',
                content: { type: 'tool_result', tool_use_id: 'x', content: 'done' }
            })
        ).toBeNull()
    })

    it('returns null when data.message is missing', () => {
        expect(classifySyntheticError({ role: 'agent', content: { type: 'output', data: {} } })).toBeNull()
    })

    it('returns null for a synthetic message with no text block', () => {
        expect(
            classifySyntheticError({
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        message: {
                            type: 'message',
                            role: 'assistant',
                            model: '<synthetic>',
                            content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }]
                        }
                    }
                }
            })
        ).toBeNull()
    })

    it('QUOTA_RESUME_PROMPT / RATE_RESUME_PROMPT self-label as system auto-resume', () => {
        expect(QUOTA_RESUME_PROMPT).toContain('系统自动恢复')
        expect(RATE_RESUME_PROMPT).toContain('系统自动恢复')
    })
})

describe('computeRateBackoff', () => {
    it('base CD = 60s (user-tuned)', () => {
        expect(RATE_BACKOFF_BASE_MS).toBe(60_000)
    })

    it('tier 0 → 60s, tier 1 → 120s, tier 4 → 960s (exponential)', () => {
        expect(computeRateBackoff(0)).toEqual({ delayMs: 60_000 })
        expect(computeRateBackoff(1)).toEqual({ delayMs: 120_000 })
        expect(computeRateBackoff(4)).toEqual({ delayMs: 960_000 })
    })

    it('tier ≥ 5 (cap) → null (silent stop, no human alert)', () => {
        expect(computeRateBackoff(5)).toBeNull()
        expect(computeRateBackoff(10)).toBeNull()
    })

    it('negative / non-finite → null', () => {
        expect(computeRateBackoff(-1)).toBeNull()
        expect(computeRateBackoff(Number.NaN)).toBeNull()
    })
})

describe('rateWindow', () => {
    it('floor(now / 60s)', () => {
        expect(rateWindow(0)).toBe(0)
        expect(rateWindow(59_999)).toBe(0)
        expect(rateWindow(60_000)).toBe(1)
        expect(rateWindow(125_000)).toBe(2)
    })
})
