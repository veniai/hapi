import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBar } from './StatusBar'
import { I18nProvider } from '@/lib/i18n-context'

const baseProps = {
    active: true,
    thinking: false,
    agentState: null
}

function renderStatusBar(props: Omit<Partial<Parameters<typeof StatusBar>[0]>, keyof typeof baseProps> & Partial<typeof baseProps>) {
    render(
        <I18nProvider>
            <StatusBar {...baseProps} {...(props as Partial<Parameters<typeof StatusBar>[0]>)} />
        </I18nProvider>
    )
}

describe('StatusBar reasoning label (single display site, raw value)', () => {
    it('claude shows raw effort value', () => {
        renderStatusBar({ agentFlavor: 'claude', effort: 'high' })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('high')
    })

    it('claude shows auto placeholder when effort unset', () => {
        renderStatusBar({ agentFlavor: 'claude', effort: null })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('auto')
    })

    it('codex shows raw reasoning value (no "reasoning" prefix)', () => {
        renderStatusBar({ agentFlavor: 'codex', modelReasoningEffort: 'xhigh' })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('xhigh')
    })

    it('codex shows default placeholder when unset', () => {
        renderStatusBar({ agentFlavor: 'codex', modelReasoningEffort: null })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('default')
    })

    it('opencode shows raw level', () => {
        renderStatusBar({ agentFlavor: 'opencode', modelReasoningEffort: 'high' })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('high')
    })

    it('pi shows raw thinking level', () => {
        renderStatusBar({ agentFlavor: 'pi', effort: 'minimal' })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('minimal')
    })

    it('grok uses option name', () => {
        renderStatusBar({
            agentFlavor: 'grok',
            effort: 'think-high',
            grokReasoningOptions: [{ value: 'think-high', name: 'Think High' }]
        })
        expect(screen.getByTestId('status-bar-reasoning').textContent).toBe('Think High')
    })

    it('cursor does not render a reasoning label', () => {
        renderStatusBar({ agentFlavor: 'cursor', effort: 'high' })
        expect(screen.queryByTestId('status-bar-reasoning')).toBeNull()
    })
})
