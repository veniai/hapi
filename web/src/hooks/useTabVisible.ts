import { useEffect, useState } from 'react'

/**
 * 页面是否可见（document.visibilityState === 'visible'）。
 *
 * L0.2 markSessionSeen 门控用（hidden 时冻结水位）；
 * L3.1 定位也复用（visible 恢复时重新定位）。
 */
export function useTabVisible(): boolean {
    const [visible, setVisible] = useState<boolean>(() => {
        if (typeof document === 'undefined') {
            return false
        }
        return document.visibilityState === 'visible'
    })

    useEffect(() => {
        const onVisibilityChange = () => {
            setVisible(document.visibilityState === 'visible')
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [])

    return visible
}
