import { describe, expect, it } from 'vitest'
import { getAppGlobalSseSubscription } from './appSseSubscriptions'

describe('app SSE subscriptions', () => {
    it('always uses a global all:true subscription', () => {
        expect(getAppGlobalSseSubscription()).toEqual({ all: true })
    })
})
