import { describe, expect, it } from 'bun:test'
import { classifySyntheticQuotaError, QUOTA_RESUME_PROMPT } from './autoResume'

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

describe('classifySyntheticQuotaError', () => {
    it('classifies a real synthetic [1308] quota error and parses the reset time', () => {
        const result = classifySyntheticQuotaError(syntheticContent(QUOTA_1308_TEXT))
        expect(result).not.toBeNull()
        expect(result!.code).toBe('1308')
        // Full-field reset-time assertion (spec §8.1 P2): every component, not just
        // hours. Catches minute/second parse errors AND UTC-misinterpretation — a UTC
        // parse would shift getHours() off under any non-UTC test-machine TZ.
        const d = new Date(result!.resetsAtMs)
        expect(d.getFullYear()).toBe(2026)
        expect(d.getMonth()).toBe(6) // July (0-indexed)
        expect(d.getDate()).toBe(17)
        expect(d.getHours()).toBe(16)
        expect(d.getMinutes()).toBe(1)
        expect(d.getSeconds()).toBe(19)
    })

    it('captures the numeric [1308] code, not the (429) status', () => {
        const result = classifySyntheticQuotaError(syntheticContent(QUOTA_1308_TEXT))
        expect(result!.code).toBe('1308')
    })

    it('returns null for agent-authored discussion of the error (real model name)', () => {
        // Same error text, but model is the real glm-5.2 — the agent typing about
        // the error, not the harness injecting it. Sentinel gating must exclude it.
        expect(classifySyntheticQuotaError(syntheticContent(QUOTA_1308_TEXT, 'glm-5.2'))).toBeNull()
    })

    it('returns null for transient errors without a reset time', () => {
        expect(classifySyntheticQuotaError(syntheticContent('[1302]请您控制请求频率'))).toBeNull()
    })

    it('returns null for a tool_result envelope (role:user, no model)', () => {
        expect(
            classifySyntheticQuotaError({
                role: 'user',
                content: { type: 'tool_result', tool_use_id: 'x', content: 'done' }
            })
        ).toBeNull()
    })

    it('returns null when data.message is missing', () => {
        expect(
            classifySyntheticQuotaError({
                role: 'agent',
                content: { type: 'output', data: {} }
            })
        ).toBeNull()
    })

    it('returns null for a synthetic message with no text block', () => {
        expect(
            classifySyntheticQuotaError({
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

    it('QUOTA_RESUME_PROMPT self-labels as a system auto-resume', () => {
        expect(QUOTA_RESUME_PROMPT).toContain('系统自动恢复')
    })
})
