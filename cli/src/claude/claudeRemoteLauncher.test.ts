import { describe, expect, it } from 'vitest'
import type { SDKResultMessage } from './sdk'
import { shouldBuildResultUsageCarrier } from './claudeRemoteLauncher'

function result(subtype: SDKResultMessage['subtype'], withUsage = true): SDKResultMessage {
    return {
        type: 'result',
        subtype,
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: subtype !== 'success',
        session_id: 'session-1',
        ...(withUsage ? { usage: { input_tokens: 10, output_tokens: 2 } } : {})
    }
}

describe('shouldBuildResultUsageCarrier', () => {
    it.each(['success', 'error_max_turns', 'error_during_execution'] as const)(
        'keeps GLM context usage for %s results',
        (subtype) => {
            expect(shouldBuildResultUsageCarrier(result(subtype), true)).toBe(true)
        }
    )

    it('skips results without usage and native Claude turns with exact usage', () => {
        expect(shouldBuildResultUsageCarrier(result('error_during_execution', false), true)).toBe(false)
        expect(shouldBuildResultUsageCarrier(result('success'), false)).toBe(false)
    })
})
