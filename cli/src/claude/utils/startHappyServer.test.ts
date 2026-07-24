import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { startHappyServer } from './startHappyServer'

type ToolResult = {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
}

describe('startHappyServer skill_lookup', () => {
    const originalHome = process.env.HOME
    let sandboxDir: string
    let workingDirectory: string
    let client: Client | null
    let stopServer: (() => void) | null

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skill-mcp-'))
        workingDirectory = join(sandboxDir, 'repo')
        process.env.HOME = join(sandboxDir, 'home')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        await mkdir(process.env.HOME, { recursive: true })
        client = null
        stopServer = null
    })

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        vi.unstubAllGlobals()
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function connect(enableSkillLookup = true): Promise<Client> {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, enableSkillLookup
            ? {
                skillLookup: {
                    workingDirectory,
                    flavor: 'opencode'
                }
            }
            : {})
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-skill-lookup-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('returns a discovered SKILL.md body', async () => {
        const skillDir = join(workingDirectory, '.agents', 'skills', 'review')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: review',
            'description: Review changes safely',
            '---',
            '',
            '# Review instructions',
            '',
            'Inspect the diff before editing.'
        ].join('\n'))

        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Skill: review')
        expect(result.content?.[0]?.text).toContain('Description: Review changes safely')
        expect(result.content?.[0]?.text).toContain('# Review instructions')
    })

    it('returns a tool error for an unknown skill', async () => {
        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'missing' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Skill not found: missing')
    })

    it('does not expose the fallback tool to native-skill sessions', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()

        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'change_title',
            'display_image',
            'search_sibling'
        ])
    })

    it('scopes sibling search to the workspace and excludes the current session', async () => {
        const originalFetch = globalThis.fetch
        const fetchImplementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const requestUrl = typeof input === 'string'
                ? new URL(input)
                : input instanceof URL
                    ? input
                    : new URL(input.url)
            if (requestUrl.pathname === '/cli/search') {
                return new Response(JSON.stringify({ hits: [{
                    messageId: 'message-1',
                    sessionId: 'sibling-session',
                    sessionName: '调整发送按钮尺寸',
                    sessionUrl: 'https://hapi.example.com/sessions/sibling-session',
                    seq: 369,
                    path: workingDirectory,
                    contentSnippet: 'h-[50px] w-[50px]'
                }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
            }
            return originalFetch(input, init)
        }
        const fetchMock = vi.fn(fetchImplementation)
        vi.stubGlobal('fetch', fetchMock)

        const sessionClient = {
            sessionId: 'current-session',
            getToken: () => 'test-token',
            getWorkspacePath: () => workingDirectory,
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient)
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-sibling-search-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const result = await client.callTool({
            name: 'search_sibling',
            arguments: { query: 'send button', limit: 7 }
        }) as ToolResult
        expect(result.content?.[0]?.text).toContain('调整发送按钮尺寸')
        expect(result.content?.[0]?.text).toContain('sibling-session')
        expect(result.content?.[0]?.text).toContain('(https://hapi.example.com/sessions/sibling-session)')

        const searchCalls = fetchMock.mock.calls.filter(([input]) => {
            const requestUrl = typeof input === 'string'
                ? new URL(input)
                : input instanceof URL
                    ? input
                    : new URL(input.url)
            return requestUrl.pathname === '/cli/search'
        })
        expect(searchCalls).toHaveLength(1)
        const requestUrl = new URL(String(searchCalls[0]?.[0]))
        expect(requestUrl.pathname).toBe('/cli/search')
        expect(requestUrl.searchParams.get('q')).toBe('send button')
        expect(requestUrl.searchParams.get('path')).toBe(workingDirectory)
        expect(requestUrl.searchParams.get('sessionId')).toBe('current-session')
        expect(requestUrl.searchParams.get('limit')).toBe('7')
    })
})
