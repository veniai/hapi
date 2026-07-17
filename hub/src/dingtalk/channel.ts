import { createHmac } from 'node:crypto'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getSessionName } from '../notifications/sessionInfo'

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
        private readonly keyword?: string
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!session.active) return
        await this.send(`${getSessionName(session)}·空闲`)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) return
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const tool = request?.tool ? ` ${request.tool}` : ''
        await this.send(`${getSessionName(session)}·待审批${tool}`)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) return
        const status = notification.status?.trim().toLowerCase()
        const isFailure = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
        const label = isFailure ? '失败' : '完成'
        const preview = notification.summary ? ` ${truncate(notification.summary, 60)}` : ''
        await this.send(`${getSessionName(session)}·${label}${preview}`)
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        await this.send(`${getSessionName(session)}·完成`)
    }

    /**
     * 发钉钉：webhook + 可选 HMAC-SHA256 签名（timestamp+sign 查询参数）+ 关键词过滤
     * （钉钉机器人安全设置；content 须含关键词，否则被拒）。payload 用 text
     * （L3.3 deep link 再改 markdown 支持可点链接）。
     */
    private async send(content: string): Promise<void> {
        const finalContent = this.keyword && !content.includes(this.keyword)
            ? `${content} ${this.keyword}`
            : content

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
            body: JSON.stringify({ msgtype: 'text', text: { content: finalContent } })
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`钉钉发送失败: HTTP ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
        }
    }
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
