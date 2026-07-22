import { useEffect } from 'react'
import type { ApiClient } from '@/api/client'
import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'

/**
 * Reconcile the selected session's queued state once per (connection, session):
 *   - first entry: when the global SSE connection reports ready (subscriptionId set)
 *   - session switch: when sessionId changes
 *   - reconnect: when a fresh subscriptionId arrives
 *
 * Gating on `subscriptionId` (only assigned after the hub accepts the connection and
 * emits connection-changed) ensures syncEngine/sseManager are ready before the HTTP
 * reconcile (fetchLatest + getQueuedState) fires. Extracted from App so the wiring is
 * unit-testable without a full App render.
 */
export function useQueuedStateReconciliation(
    api: ApiClient | null,
    sessionId: string | null,
    subscriptionId: string | null
): void {
    useEffect(() => {
        if (!api || !sessionId || !subscriptionId) {
            return
        }
        void reconcileQueuedStateAfterConnect(api, sessionId).catch((error) => {
            console.error('Failed to reconcile queued state:', error)
        })
    }, [api, sessionId, subscriptionId])
}
