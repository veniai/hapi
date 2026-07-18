import { createHmac } from 'node:crypto'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getSessionName } from '../notifications/sessionInfo'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

/**
 * 钉钉通知渠道（L2.1，简化版）。按 hub notification event 发钉钉机器人消息，
 * 文案 cc-monitor 风格：`{项目名}·{状态}{预览}`，无标题前缀。
 *
 * 诚实语义（Codex 修正）：hub 的 ready 事件在 abort / prompt 失败 / 进程异常后
 * 也会触发（payload 固定 {type:'ready'}，hub 无法区分 outcome），故 sendReady
 * 文案用「空闲」而非「完成」，避免 abort 后误导为已完成。
 *
 * 不推 unread（hub 无 lastSeenAt + AFK 刷屏）。session 异常结束（error/terminated）
 * 当前 hub 静默、无 cause 文本，本渠道不覆盖。
 */
export class DingtalkChannel implements NotificationChannel {
    constructor(
        private readonly webhook: string,
        private readonly secret?: string,
        private readonly keyword?: string,
        private readonly publicUrl?: string,
        private readonly visibilityTracker?: VisibilityTracker
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!session.active) return
        if (this.visibilityTracker?.hasVisibleConnection(session.namespace)) return
        await this.send(`${getSessionName(session)}·空闲`, session.id)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) return
        if (this.visibilityTracker?.hasVisibleConnection(session.namespace)) return
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests).sort(
                (a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER)
            )[0]
            : null
        const tool = request?.tool ? ` ${request.tool}` : ''
        await this.send(`${getSessionName(session)}·待审批${tool}`, session.id)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) return
        if (this.visibilityTracker?.hasVisibleConnection(session.namespace)) return
        const status = notification.status?.trim().toLowerCase()
        const isFailure = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
        const label = isFailure ? '失败' : '完成'
        const preview = notification.summary ? ` ${truncate(notification.summary, 60)}` : ''
        await this.send(`${getSessionName(session)}·${label}${preview}`, session.id)
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (this.visibilityTracker?.hasVisibleConnection(session.namespace)) return
        await this.send(`${getSessionName(session)}·完成`, session.id)
    }

    /**
     * 发钉钉：webhook + 可选 HMAC-SHA256 签名（timestamp+sign 查询参数）+ 关键词过滤。
     * payload 用 markdown（L3.3）：支持「打开会话」可点链接（text 消息不支持 markdown 链接）。
     */
    private async send(content: string, sessionId?: string): Promise<void> {
        const sessionUrl = sessionId && this.publicUrl
            ? buildSessionUrl(this.publicUrl, sessionId)
            : null
        const text = sessionUrl
            ? `${content}\n\n[打开会话](${sessionUrl})`
            : content
        const finalText = this.keyword && !text.includes(this.keyword)
            ? `${text} ${this.keyword}`
            : text

        let url = this.webhook
        if (this.secret) {
            const timestamp = Date.now()
            const sign = signWithSecret(timestamp, this.secret)
            const sep = url.includes('?') ? '&' : '?'
            url = `${url}${sep}timestamp=${timestamp}&sign=${sign}`
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { title: content.slice(0, 20), text: finalText }
            })
        })

        const responseText = await response.text().catch(() => '')
        if (!response.ok) {
            const errText = responseText
            throw new Error(`钉钉发送失败: HTTP ${response.status} ${response.statusText}${errText ? ` - ${errText}` : ''}`)
        }
        let payload: { errcode?: unknown; errmsg?: unknown }
        try {
            payload = JSON.parse(responseText) as { errcode?: unknown; errmsg?: unknown }
        } catch {
            throw new Error('钉钉发送失败: 响应不是有效 JSON')
        }
        if (typeof payload.errcode !== 'number') {
            throw new Error('钉钉发送失败: 响应缺少 errcode')
        }
        if (payload.errcode !== 0) {
            const detail = typeof payload.errmsg === 'string' && payload.errmsg
                ? ` ${payload.errmsg}`
                : ''
            throw new Error(`钉钉发送失败: errcode ${payload.errcode}${detail}`)
        }
    }
}

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    const normalized = baseUrl.replace(/\/+$/, '')
    return `${normalized}/sessions/${sessionId}`
}

function truncate(text: string, max: number): string {
    const trimmed = text.trim()
    return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

/**
 * 钉钉机器人签名：HMAC-SHA256(timestamp + "\n" + secret) → base64 → urlencode，
 * 作 sign 查询参数。参考 cc-monitor/channels/dingtalk.sh。
 */
export function signWithSecret(timestamp: number, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`
    const hmac = createHmac('sha256', secret).update(stringToSign).digest('base64')
    return encodeURIComponent(hmac)
}
