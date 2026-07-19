import type { SessionSummary } from '@/types/api'

export type SessionAttentionKind = 'permission' | 'input' | 'background' | 'unread'
export type SessionAttention = { kind: SessionAttentionKind }

export type AttentionOptions = {
    /** This device's seen attention revision (per-device localStorage, stamped
     *  on explicit click-entry — 规则 A 本端灭). */
    localSeenRev: number
    /** Hub-authoritative handled revision (advanced on ANY device's successful
     *  send — 规则 B 两端灭). */
    handledRev: number
}

/** Classify the attention KIND purely from session state (no seen/handled).
 *  Returns null for archived sessions. `thinking` suppresses the "busy" kinds
 *  (background/unread) — the agent is working, not blocked — but NOT
 *  permission/input, where the agent is waiting on the user (§3.1.9). */
export function classifyAttentionKind(summary: SessionSummary): SessionAttentionKind | null {
    if (summary.metadata?.lifecycleState === 'archived') {
        return null
    }

    const pendingRequestKinds = Array.isArray(summary.pendingRequestKinds)
        ? summary.pendingRequestKinds
        : []

    if (pendingRequestKinds.includes('permission')) {
        return 'permission'
    }

    if (pendingRequestKinds.includes('input')) {
        return 'input'
    }

    if (summary.thinking) {
        return null
    }

    if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
        return 'background'
    }

    return 'unread'
}

/** §2.1 lit condition: a newer attention revision exists than both what this
 *  device has seen AND what any device has handled.
 *    亮 = attentionRev > max(localSeenRev, handledRev)
 *  Defends against undefined (pre-migration rows / stale cache) with 0 — safe
 *  side: no false red dot during the transition. */
export function isAttentionLit(summary: SessionSummary, options: AttentionOptions): boolean {
    const rev = summary.attentionRev ?? 0
    return rev > Math.max(options.localSeenRev ?? 0, options.handledRev ?? 0)
}

/** Public classifier (preserves the call-site shape): returns the attention
 *  kind when the session is BOTH attention-worthy and lit, else null.
 *
 *  Red-dot model per doc/spec/web-chat-read-position-sync.md §2.1/§3.1.
 *  Click-entry advances localSeenRev (规则 A — clears this device only); a
 *  successful send on any device advances handledRev via hub SSE (规则 B —
 *  clears all devices). A new attention-worthy event bumps attentionRev on the
 *  hub, re-lighting every device that has not since clicked or sent. */
export function classifySessionAttention(
    summary: SessionSummary,
    options: AttentionOptions
): SessionAttention | null {
    const kind = classifyAttentionKind(summary)
    if (kind === null) {
        return null
    }
    if (!isAttentionLit(summary, options)) {
        return null
    }
    return { kind }
}

export function getSessionAttentionLabelKey(attention: SessionAttention): string {
    switch (attention.kind) {
        case 'permission':
            return 'session.item.permission'
        case 'input':
            return 'session.item.needsInput'
        case 'background':
            return 'session.item.background'
        case 'unread':
            return 'session.item.newActivity'
    }
}
