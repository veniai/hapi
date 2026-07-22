import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { useQueuedStateReconciliation } from './useQueuedStateReconciliation'

vi.mock('@/lib/queued-state-reconciliation', () => ({
    reconcileQueuedStateAfterConnect: vi.fn().mockResolvedValue(undefined),
}))

import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'

const mockReconcile = vi.mocked(reconcileQueuedStateAfterConnect)

// Stable identity — only used as the `api` argument; reconcile is mocked so it never
// actually touches the network.
const api = {} as ApiClient

describe('useQueuedStateReconciliation', () => {
    beforeEach(() => {
        mockReconcile.mockClear()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('does nothing until the connection is ready (no subscriptionId)', () => {
        renderHook(() => useQueuedStateReconciliation(api, 's1', null))
        expect(mockReconcile).not.toHaveBeenCalled()
    })

    it('reconciles once when the connection becomes ready for the current session', () => {
        const { rerender } = renderHook(
            ({ sid, sub }) => useQueuedStateReconciliation(api, sid, sub),
            { initialProps: { sid: 's1', sub: null as string | null } }
        )
        expect(mockReconcile).not.toHaveBeenCalled()
        rerender({ sid: 's1', sub: 'sub-1' })
        expect(mockReconcile).toHaveBeenCalledTimes(1)
        expect(mockReconcile).toHaveBeenCalledWith(api, 's1')
    })

    it('reconciles the new session on switch', () => {
        const { rerender } = renderHook(
            ({ sid, sub }) => useQueuedStateReconciliation(api, sid, sub),
            { initialProps: { sid: 's1', sub: 'sub-1' } }
        )
        expect(mockReconcile).toHaveBeenCalledTimes(1)
        rerender({ sid: 's2', sub: 'sub-1' })
        expect(mockReconcile).toHaveBeenCalledTimes(2)
        expect(mockReconcile).toHaveBeenLastCalledWith(api, 's2')
    })

    it('reconciles again on reconnect (new subscriptionId) for the current session', () => {
        const { rerender } = renderHook(
            ({ sid, sub }) => useQueuedStateReconciliation(api, sid, sub),
            { initialProps: { sid: 's1', sub: 'sub-1' } }
        )
        expect(mockReconcile).toHaveBeenCalledTimes(1)
        rerender({ sid: 's1', sub: 'sub-2' })
        expect(mockReconcile).toHaveBeenCalledTimes(2)
        expect(mockReconcile).toHaveBeenLastCalledWith(api, 's1')
    })

    it('does nothing without an api', () => {
        renderHook(() => useQueuedStateReconciliation(null, 's1', 'sub-1'))
        expect(mockReconcile).not.toHaveBeenCalled()
    })
})
