/**
 * Unified "reasoning strength" label for the composer StatusBar (the single
 *常驻 display site after the SessionHeader copy was removed).
 *
 *原样 display: no translation table, no title-casing — the raw effort value
 * (trimmed + lower-cased) is shown as-is. Default/unset shows a small
 * placeholder so the operator always sees the current strength.
 *
 * Per-flavor source field:
 *   codex / opencode → modelReasoningEffort
 *   claude / pi / grok → effort
 *   cursor / unknown → null (do not render; cursor's StatusBar is also hidden
 *   wholesale by shouldShowComposerStatusBar, this is defense-in-depth).
 */

export type ReasoningGrokOption = { value: string; name?: string }

export type ReasoningLabelArgs = {
    flavor: string | null | undefined
    /** codex / opencode source. */
    modelReasoningEffort?: string | null
    /** claude / pi / grok source. */
    effort?: string | null
    /** grok runtime options, to map an effort wire id to a friendly name. */
    grokOptions?: ReadonlyArray<ReasoningGrokOption> | null
}

function normalize(value: string | null | undefined): string | null {
    const trimmed = value?.trim().toLowerCase()
    return trimmed ? trimmed : null
}

export function formatReasoningStatusLabel(args: ReasoningLabelArgs): string | null {
    const { flavor } = args

    if (flavor === 'codex' || flavor === 'opencode') {
        return normalize(args.modelReasoningEffort) ?? 'default'
    }
    if (flavor === 'claude' || flavor === 'pi') {
        return normalize(args.effort) ?? 'auto'
    }
    if (flavor === 'grok') {
        const effort = normalize(args.effort)
        if (!effort) return 'default'
        // Prefer the server-provided friendly name; fall back to the raw wire id.
        const match = args.grokOptions?.find((option) => option.value.toLowerCase() === effort)
        return match?.name ?? effort
    }

    return null
}
