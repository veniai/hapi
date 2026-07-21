import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Session } from '@/types/api'

// Dialog / menu 子组件各自拉 context（useToast 等），与本测试无关，mock 成空实现，
// 让 SessionHeader 主体（header 条）能独立渲染，专注断言 reasoning 已从 header 移除。
vi.mock('./SessionExportDialog', () => ({ SessionExportDialog: () => null }))
vi.mock('./RenameSessionDialog', () => ({ RenameSessionDialog: () => null }))
vi.mock('./SessionActionMenu', () => ({ SessionActionMenu: () => null }))
vi.mock('./ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }))

import { SessionHeader } from './SessionHeader'
import { I18nProvider } from '@/lib/i18n-context'

function Wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    return (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>{children}</I18nProvider>
        </QueryClientProvider>
    )
}

const codexSession = {
    id: 's-codex',
    namespace: 'default',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    metadata: { flavor: 'codex' },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    model: 'gpt-5',
    modelReasoningEffort: 'xhigh'
} as unknown as Session

describe('SessionHeader reasoning (removed from header)', () => {
    it('does not render a reasoning label in the header for a codex session', () => {
        render(
            <SessionHeader session={codexSession} onBack={() => {}} api={null} />,
            { wrapper: Wrapper }
        )
        expect(screen.queryByTestId('session-header-reasoning')).toBeNull()
    })
})
