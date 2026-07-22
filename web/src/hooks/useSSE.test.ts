import { describe, expect, it } from 'vitest'
import { computeReconnectDelay, isGlobalScopedMessageStreamEvent } from './useSSE'

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('computeReconnectDelay', () => {
    it('skips the first-attempt backoff for visibility recovery (attempt 0)', () => {
        expect(computeReconnectDelay(0, 'visibility-recovery')).toBe(0)
    })

    it('keeps exponential backoff for error / heartbeat-timeout at attempt 0', () => {
        // attempt 0 → 1000 * 2^0 + jitter(0..500) = [1000, 1500]
        expect(computeReconnectDelay(0, 'closed')).toBeGreaterThanOrEqual(1000)
        expect(computeReconnectDelay(0, 'closed')).toBeLessThanOrEqual(1500)
        expect(computeReconnectDelay(0, 'heartbeat-timeout')).toBeGreaterThanOrEqual(1000)
        expect(computeReconnectDelay(0, 'heartbeat-timeout')).toBeLessThanOrEqual(1500)
    })

    it('resumes exponential backoff after the visibility-recovery first attempt fails', () => {
        // attempt 1 → 1000 * 2^1 + jitter(0..500) = [2000, 2500]
        const delay = computeReconnectDelay(1, 'visibility-recovery')
        expect(delay).toBeGreaterThanOrEqual(2000)
        expect(delay).toBeLessThanOrEqual(2500)
    })
})
