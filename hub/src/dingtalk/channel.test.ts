import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { DingtalkChannel, signWithSecret } from './channel'
import type { Session } from '../sync/syncEngine'

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        active: true,
        thinking: false,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 0,
        metadata: { name: 'my-project', path: '/p' },
        agentState: {},
        ...overrides
    } as unknown as Session
}

describe('signWithSecret', () => {
    it('HMAC-SHA256(timestamp + "\\n" + secret) → base64 → urlencode（对齐钉钉签名协议）', () => {
        const timestamp = 1_700_000_000_000
        const secret = 'SECabc123'
        const expected = encodeURIComponent(
            createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
        )
        expect(signWithSecret(timestamp, secret)).toBe(expected)
    })
})

describe('DingtalkChannel', () => {
    const fetchMock = vi.fn()

    const originalFetch = globalThis.fetch
    afterEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = originalFetch
    })

    function makeChannel(opts: { secret?: string; keyword?: string; publicUrl?: string; visible?: boolean } = {}): DingtalkChannel {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' })
        })
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        const tracker = opts.visible === undefined
            ? undefined
            : ({ hasVisibleConnection: () => opts.visible } as never)
        return new DingtalkChannel(
            'https://oapi.dingtalk.com/robot/send?access_token=x',
            opts.secret,
            opts.keyword,
            opts.publicUrl,
            tracker
        )
    }

    function lastCall(): { url: string; body: any } {
        const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
        return { url: url as string, body: JSON.parse(init.body) }
    }

    it('sendReady 文案「项目名·空闲」+ POST markdown payload', async () => {
        const ch = makeChannel()
        await ch.sendReady(makeSession())
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const { body } = lastCall()
        expect(body.msgtype).toBe('markdown')
        expect(body.markdown.text).toBe('my-project·空闲')
    })

    it('sendTaskNotification failed → 「项目名·失败 summary」', async () => {
        const ch = makeChannel()
        await ch.sendTaskNotification(makeSession(), { summary: 'agent crashed', status: 'failed' })
        const { body } = lastCall()
        expect(body.markdown.text).toContain('my-project·失败')
        expect(body.markdown.text).toContain('agent crashed')
    })

    it('sendPermissionRequest 带审批 tool 名', async () => {
        const ch = makeChannel()
        await ch.sendPermissionRequest(makeSession({
            agentState: { requests: { r1: { tool: 'Bash', arguments: {}, createdAt: 0 } } } as any
        }))
        const { body } = lastCall()
        expect(body.markdown.text).toBe('my-project·待审批 Bash')
    })

    it('sendPermissionRequest 选择 createdAt 最早的审批请求', async () => {
        const ch = makeChannel()
        await ch.sendPermissionRequest(makeSession({
            agentState: {
                requests: {
                    later: { tool: 'Write', arguments: {}, createdAt: 20 },
                    earlier: { tool: 'Read', arguments: {}, createdAt: 10 }
                }
            } as any
        }))
        expect(lastCall().body.markdown.text).toBe('my-project·待审批 Read')
    })

    it('secret 加签 → URL 含 timestamp & sign 查询参数', async () => {
        const ch = makeChannel({ secret: 'SECabc' })
        await ch.sendReady(makeSession())
        const { url } = lastCall()
        expect(url).toMatch(/timestamp=\d+/)
        expect(url).toMatch(/sign=/)
    })

    it('keyword → content 末尾追加关键词（钉钉机器人安全过滤）', async () => {
        const ch = makeChannel({ keyword: '~' })
        await ch.sendReady(makeSession())
        const { body } = lastCall()
        expect(body.markdown.text).toBe('my-project·空闲 ~')
    })

    it('非 active session 不发（ready/task/permission）', async () => {
        const ch = makeChannel()
        await ch.sendReady(makeSession({ active: false }))
        await ch.sendTaskNotification(makeSession({ active: false }), { summary: 'x', status: 'failed' })
        await ch.sendPermissionRequest(makeSession({ active: false }))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('publicUrl + sessionId → markdown 含「打开会话」链接（L3.3 deep link）', async () => {
        const ch = makeChannel({ publicUrl: 'https://hapi.example.com/' })
        await ch.sendReady(makeSession({ id: 's1' }))
        const { body } = lastCall()
        expect(body.msgtype).toBe('markdown')
        expect(body.markdown.text).toContain('my-project·空闲')
        expect(body.markdown.text).toMatch(/\[打开会话\]\(https:\/\/hapi\.example\.com\/sessions\/s1\)/)
    })

    it('HTTP 200 但 errcode 非零时抛出钉钉业务错误', async () => {
        const ch = makeChannel()
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ errcode: 310000, errmsg: 'keywords not in content' })
        })

        await expect(ch.sendReady(makeSession())).rejects.toThrow(
            '钉钉发送失败: errcode 310000 keywords not in content'
        )
    })

    it('HTTP 200 但响应不可解析时抛错', async () => {
        const ch = makeChannel()
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>proxy error</html>' })

        await expect(ch.sendReady(makeSession())).rejects.toThrow('钉钉发送失败: 响应不是有效 JSON')
    })

    it('web tab 可见时抑制所有 send*(ready/permission/task/completion)', async () => {
        const ch = makeChannel({ visible: true })
        await ch.sendReady(makeSession())
        await ch.sendPermissionRequest(makeSession({
            agentState: { requests: { r1: { tool: 'Bash', arguments: {}, createdAt: 0 } } } as any
        }))
        await ch.sendTaskNotification(makeSession(), { summary: 'boom', status: 'failed' })
        await ch.sendSessionCompletion(makeSession(), 'completed' as any)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('web tab 不可见时正常发送', async () => {
        const ch = makeChannel({ visible: false })
        await ch.sendReady(makeSession())
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
