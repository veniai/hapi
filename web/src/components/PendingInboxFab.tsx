import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useSessions } from '@/hooks/queries/useSessions'
import { useAppContext } from '@/lib/app-context'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { useSessionLastSeenVersion } from '@/hooks/useSessionLastSeen'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'

// 浮窗计入的 attention 种类：需要用户行动的三类。background（后台任务）不计入。
const PENDING_KINDS = new Set(['permission', 'input', 'unread'])

/**
 * 待处理会话浮窗（L1.3）：全局常驻，聚合 permission/input/unread 三类需要处理的
 * 会话计数。点击跳转第一个待处理会话；全部清空后隐藏。
 *
 * 数据源是 attention 判定（非易失的 toast 队列）：thinking 会话 attention 为 null，
 * 不进浮窗（不误判等子 agent）。permission/input 须等 agent 真正移除 pendingRequestKinds
 * 才清除（不会点一下就跳下一个）；unread 到达即清（导航触发 markSessionSeen）。
 *
 * 与改动四钉钉同语义（需要处理就提示）；列表未读（L1.2 时间红）是另一条独立通道。
 */
export function PendingInboxFab() {
    const { api } = useAppContext()
    const { sessions } = useSessions(api)
    const navigate = useNavigate()
    const lastSeenVersion = useSessionLastSeenVersion()

    const pendingSessions = useMemo(() => {
        // lastSeenVersion 仅作响应式触发（同 tab 事件 + 跨 tab storage），让水位变化后重算。
        void lastSeenVersion
        return sessions.filter(s => {
            const attention = classifySessionAttention(s, {
                selected: false,
                lastSeenAt: getSessionLastSeenAt(s.id)
            })
            return attention !== null && PENDING_KINDS.has(attention.kind)
        })
    }, [sessions, lastSeenVersion])

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
            aria-label={`待处理 ${pendingSessions.length} 个会话`}
            className="fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--app-accent,red)] text-base font-semibold text-white shadow-lg"
        >
            {pendingSessions.length}
        </button>
    )
}
