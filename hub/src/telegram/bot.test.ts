import { describe, expect, it, mock, spyOn } from 'bun:test'
import { HappyBot } from './bot'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeStore(): Store {
    return {
        users: {
            getUsersByPlatformAndNamespace: () => [],
            getUser: () => null
        }
    } as unknown as Store
}

function createBot() {
    const bot = new HappyBot({
        syncEngine: {} as unknown as SyncEngine,
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        publicUrl: 'https://example.com',
        store: createFakeStore()
    })
    return bot
}

function createNotifySession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        active: true,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 0,
        metadata: { path: '/p', host: 'DESKTOP' },
        thinking: false,
        agentState: null,
        ...overrides
    } as Session
}

describe('HappyBot.start', () => {
    it('logs error and resets isRunning when polling fails', async () => {
        const bot = createBot()
        const innerBot = bot.getBot()

        // Override bot.start to simulate a polling failure
        innerBot.start = mock((): Promise<void> => Promise.reject(new Error('Network failure')))

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

        await bot.start()
        // Allow microtask (.catch handler) to run
        await sleep(10)

        expect(errorSpy).toHaveBeenCalledWith(
            '[HAPIBot] Telegram bot polling failed:',
            'Network failure'
        )

        // isRunning should be reset, so start() should work again
        await bot.start()
        expect(innerBot.start).toHaveBeenCalledTimes(2)

        errorSpy.mockRestore()
    })

    it('does not call bot.start twice when already running', async () => {
        const bot = createBot()
        const innerBot = bot.getBot()

        // Simulate a long-running polling that never resolves
        innerBot.start = mock((): Promise<void> => new Promise(() => {}))

        await bot.start()
        await bot.start() // second call should be no-op

        expect(innerBot.start).toHaveBeenCalledTimes(1)
    })
})

describe('HappyBot visibility suppression', () => {
    it('suppresses send* when web tab is visible (guard fires before syncEngine/store touched)', async () => {
        const bot = new HappyBot({
            // syncEngine 留空:sendReady 若越过可见性 guard,会调 getMachinesByNamespace → 抛错。
            // 不抛即证明 guard 在那之前就 return 了。
            syncEngine: {} as unknown as SyncEngine,
            botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            publicUrl: 'https://example.com',
            store: createFakeStore(),
            visibilityTracker: { hasVisibleConnection: () => true } as never
        })
        const sendMessageSpy = mock(async () => ({}))
        bot.getBot().api.sendMessage = sendMessageSpy as never

        await bot.sendReady(createNotifySession())
        await bot.sendPermissionRequest(createNotifySession())
        await bot.sendTaskNotification(createNotifySession(), { summary: 'boom', status: 'failed' })

        expect(sendMessageSpy).not.toHaveBeenCalled()
    })
})
