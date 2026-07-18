import type { SessionSummary } from '@/types/api'

export type SessionAttention =
    | { kind: 'permission' }
    | { kind: 'input' }
    | { kind: 'background' }
    | { kind: 'unread' }

export function classifySessionAttention(
    summary: SessionSummary,
    options: { selected: boolean; lastSeenAt: number }
): SessionAttention | null {
    // 已归档（死会话）—— 永不浮出。selected 不再短路（归调用方 suppress）。
    if (summary.metadata?.lifecycleState === 'archived') {
        return null
    }

    const pendingRequestKinds = Array.isArray(summary.pendingRequestKinds)
        ? summary.pendingRequestKinds
        : []

    // 显式的「需要用户操作」请求（permission / input，含 AskUserQuestion）——
    // 即使 thinking=true 也浮出：agent 此刻卡住等用户回答，不是在忙。配套
    // dingtalk-visibility-suppression.md：外部渠道可见时静音后，跨 session 的
    // 这类请求全靠红点兜底，故必须越过 thinking 短路。
    if (pendingRequestKinds.includes('permission')) {
        return { kind: 'permission' }
    }

    if (pendingRequestKinds.includes('input')) {
        return { kind: 'input' }
    }

    // 无显式请求时，thinking 才压制「动静类」attention（unread / background）——
    // 保留「等子 agent / 正在干活不打扰」的原本意图。
    if (summary.thinking) {
        return null
    }

    if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
        return { kind: 'background' }
    }

    if (summary.updatedAt > options.lastSeenAt) {
        return { kind: 'unread' }
    }

    return null
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
