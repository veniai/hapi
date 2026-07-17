import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionLastSeenVersion } from './useSessionLastSeen'
import { markSessionSeen, STORAGE_KEY } from '../lib/sessionLastSeen'

describe('useSessionLastSeenVersion', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('初始版本号为 0', () => {
        const { result } = renderHook(() => useSessionLastSeenVersion())
        expect(result.current).toBe(0)
    })

    it('同 tab：markSessionSeen 后版本号自增', () => {
        const { result } = renderHook(() => useSessionLastSeenVersion())
        expect(result.current).toBe(0)
        act(() => {
            markSessionSeen('s1', 100)
        })
        expect(result.current).toBe(1)
        act(() => {
            markSessionSeen('s1', 200)
        })
        expect(result.current).toBe(2)
    })

    it('同 tab：水位不上升时不自增', () => {
        const { result } = renderHook(() => useSessionLastSeenVersion())
        act(() => {
            markSessionSeen('s1', 100)
        })
        expect(result.current).toBe(1)
        act(() => {
            markSessionSeen('s1', 50) // 不上升
        })
        expect(result.current).toBe(1)
    })

    it('跨 tab：STORAGE_KEY 的 storage 事件触发自增', () => {
        const { result } = renderHook(() => useSessionLastSeenVersion())
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
        })
        expect(result.current).toBe(1)
    })

    it('跨 tab：无关 key 的 storage 事件不触发', () => {
        const { result } = renderHook(() => useSessionLastSeenVersion())
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }))
        })
        expect(result.current).toBe(0)
    })
})
