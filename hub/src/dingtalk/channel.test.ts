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

    function makeChannel(opts: { secret?: string; keyword?: string; publicUrl?: string } = {}): DingtalkChannel {
        fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        return new DingtalkChannel(
            'https://oapi.dingtalk.com/robot/send?access_token=x',
            opts.secret,
            opts.keyword,
            opts.publicUrl
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
})
