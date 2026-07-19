import type { SessionPatch, SessionSummary } from '@/types/api'

function hasOwn(patch: SessionPatch, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(patch, key)
}

/** Merge a `session-updated` SSE patch (SessionPatch) into a cached
 *  SessionSummary. Extracted from useSSE so the merge — especially the §2.1
 *  attentionRev/handledRev handling — is unit-testable without an EventSource
 *  harness.
 *
 *  Conventions matching the prior inline logic:
 *  - `attentionRev`/`handledRev`: fall back to the cached value, then 0, so a
 *    patch carrying only one (or an older cached summary without the field)
 *    never yields undefined.
 *  - `backgroundTaskCount`: explicit key (incl. undefined) → coerce to 0;
 *    absent key → keep cached.
 *  - nullable model/effort: explicit key → null-if-undefined; absent → cached. */
export function applySessionSummaryPatch(current: SessionSummary, patch: SessionPatch): SessionSummary {
    return {
        ...current,
        active: patch.active ?? current.active,
        thinking: patch.thinking ?? current.thinking,
        activeAt: patch.activeAt ?? current.activeAt,
        updatedAt: patch.updatedAt ?? current.updatedAt,
        backgroundTaskCount: hasOwn(patch, 'backgroundTaskCount')
            ? patch.backgroundTaskCount ?? 0
            : current.backgroundTaskCount,
        attentionRev: patch.attentionRev ?? current.attentionRev ?? 0,
        handledRev: patch.handledRev ?? current.handledRev ?? 0,
        model: hasOwn(patch, 'model') ? patch.model ?? null : current.model,
        effort: hasOwn(patch, 'effort') ? patch.effort ?? null : current.effort
    }
}
