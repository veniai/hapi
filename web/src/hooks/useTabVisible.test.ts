import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTabVisible } from './useTabVisible'

function setVisibility(visible: boolean): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: visible ? 'visible' : 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
}

describe('useTabVisible', () => {
    beforeEach(() => {
        setVisibility(true)
    })

    it('初始跟随 document.visibilityState', () => {
        setVisibility(false)
        const { result } = renderHook(() => useTabVisible())
        expect(result.current).toBe(false)
    })

    it('visibilitychange 切换 visible/hidden', () => {
        setVisibility(true)
        const { result } = renderHook(() => useTabVisible())
        expect(result.current).toBe(true)

        act(() => setVisibility(false))
        expect(result.current).toBe(false)

        act(() => setVisibility(true))
        expect(result.current).toBe(true)
    })
})
