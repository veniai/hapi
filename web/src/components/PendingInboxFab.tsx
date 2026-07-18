import { useMemo } from 'react'
import { useMatchRoute, useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useSessions } from '@/hooks/queries/useSessions'
import { useAppContext } from '@/lib/app-context'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { reconcilePendingSessions, compareByPendingSince, getPendingSinceStore } from '@/lib/pending-since-store'
import { useSessionLastSeenVersion } from '@/hooks/useSessionLastSeen'
import { getSessionLastSeenStore } from '@/lib/sessionLastSeen'
import { useTranslation } from '@/lib/use-translation'

// 浮窗计入的 attention 种类：需要用户行动的三类。background（后台任务）不计入。
const PENDING_KINDS = new Set(['permission', 'input', 'unread'])

export function getPendingInboxSessions(
    sessions: SessionSummary[],
    selectedSessionId: string | null,
    lastSeenBySession: Readonly<Record<string, number>>
): SessionSummary[] {
    const pending = sessions.filter((session) => {
        // Archived/inactive sessions cannot be acted on and stale request state can
        // survive their shutdown. The currently open session is already in view.
        if (!session.active || session.id === selectedSessionId) {
            return false
        }
        const attention = classifySessionAttention(session, {
            selected: false,
            lastSeenAt: lastSeenBySession[session.id] ?? 0
        })
        return attention !== null && PENDING_KINDS.has(attention.kind)
    })
    // Reconcile pendingSince (首帧原子,不闪) + sort (新完成追加末尾,不插队)
    reconcilePendingSessions(pending.map((s) => s.id))
    const store = getPendingSinceStore()
    return [...pending].sort((a, b) => compareByPendingSince(a, b, store))
}

/**
 * 待处理会话浮窗（L1.3）：聚合其他活跃会话中的
 * permission/input/unread。点击跳转第一个待处理会话；当前会话不会
 * 挡住队列，已归档会话不会重新出现。
 *
 * 数据源是 attention 判定（非易失的 toast 队列）：thinking 会话 attention 为 null，
 * 不进浮窗（不误判等子 agent）。permission/input 会在离开该会话后重新
 * 出现，直到 agent 真正移除 pendingRequestKinds；unread 由导航后的
 * markSessionSeen 清除。
 *
 * 与改动四钉钉同语义（需要处理就提示）；列表未读（L1.2 时间红）是另一条独立通道。
 */
export function PendingInboxFab() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { sessions } = useSessions(api)
    const navigate = useNavigate()
    const matchRoute = useMatchRoute()
    const lastSeenVersion = useSessionLastSeenVersion()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new'
        ? sessionMatch.sessionId
        : null

    const pendingSessions = useMemo(() => {
        const lastSeenBySession = getSessionLastSeenStore()
        return getPendingInboxSessions(sessions, selectedSessionId, lastSeenBySession)
    }, [sessions, selectedSessionId, lastSeenVersion])

    if (pendingSessions.length === 0) {
        return null
    }

    const handleClick = () => {
        const first = pendingSessions[0]
        if (first) {
            navigate({ to: '/sessions/$sessionId', params: { sessionId: first.id } })
        }
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            aria-label={t('misc.pendingSessions', { n: pendingSessions.length })}
            className="fixed z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--app-accent,red)] text-base font-semibold text-white shadow-lg"
            style={{
                bottom: 'calc(5.5rem + var(--app-floating-bottom-offset, 0px) + env(safe-area-inset-bottom))',
                right: 'calc(1rem + env(safe-area-inset-right))'
            }}
        >
            {pendingSessions.length}
        </button>
    )
}
