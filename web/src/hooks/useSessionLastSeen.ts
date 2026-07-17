import { useEffect, useState } from 'react'
import { SESSION_LAST_SEEN_EVENT, STORAGE_KEY } from '@/lib/sessionLastSeen'

/**
 * 订阅 session last-seen 水位变化的版本号。
 *
 * 返回的 version 在以下两种情况自增，用作 useMemo/依赖数组里的响应式触发器
 * （因 getSessionLastSeenAt 同步读 localStorage、本身不响应）：
 * - 同 tab：markSessionSeen 派发的 SESSION_LAST_SEEN_EVENT（浏览器 storage 事件
 *   不在执行 setItem 的当前 tab 触发，故靠自通知）。
 * - 跨 tab：其他 tab 改了 STORAGE_KEY 触发的 storage 事件。
 *
 * 用法：
 *   const version = useSessionLastSeenVersion()
 *   const lastSeenAt = useMemo(() => getSessionLastSeenAt(sessionId), [sessionId, version])
 */
export function useSessionLastSeenVersion(): number {
    const [version, setVersion] = useState(0)

    useEffect(() => {
        const bump = () => setVersion((v) => v + 1)

        window.addEventListener(SESSION_LAST_SEEN_EVENT, bump)
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY || event.key === null) {
                bump()
            }
        }
        window.addEventListener('storage', onStorage)

        return () => {
            window.removeEventListener(SESSION_LAST_SEEN_EVENT, bump)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    return version
}
