import { describe, expect, it } from 'vitest'
import { formatReasoningStatusLabel } from './reasoningStatusLabels'

describe('formatReasoningStatusLabel', () => {
    describe('codex / opencode', () => {
        it('shows default placeholder for null/undefined/default', () => {
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: null })).toBe('default')
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: undefined })).toBe('default')
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: 'default' })).toBe('default')
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: '  DEFAULT  ' })).toBe('default')
            expect(formatReasoningStatusLabel({ flavor: 'opencode', modelReasoningEffort: null })).toBe('default')
        })

        it('shows raw effort value as-is (no prefix, no title-case)', () => {
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: 'xhigh' })).toBe('xhigh')
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: 'Ultra' })).toBe('ultra')
            expect(formatReasoningStatusLabel({ flavor: 'opencode', modelReasoningEffort: 'high' })).toBe('high')
            expect(formatReasoningStatusLabel({ flavor: 'codex', modelReasoningEffort: 'turbo' })).toBe('turbo')
        })
    })

    describe('claude', () => {
        it('shows auto placeholder for null/empty', () => {
            expect(formatReasoningStatusLabel({ flavor: 'claude', effort: null })).toBe('auto')
            expect(formatReasoningStatusLabel({ flavor: 'claude', effort: undefined })).toBe('auto')
        })

        it('shows raw effort value as-is', () => {
            expect(formatReasoningStatusLabel({ flavor: 'claude', effort: 'high' })).toBe('high')
            expect(formatReasoningStatusLabel({ flavor: 'claude', effort: 'xhigh' })).toBe('xhigh')
            expect(formatReasoningStatusLabel({ flavor: 'claude', effort: 'max' })).toBe('max')
        })
    })

    describe('pi', () => {
        it('shows auto placeholder for null/empty', () => {
            expect(formatReasoningStatusLabel({ flavor: 'pi', effort: null })).toBe('auto')
        })

        it('shows raw thinking level as-is', () => {
            expect(formatReasoningStatusLabel({ flavor: 'pi', effort: 'off' })).toBe('off')
            expect(formatReasoningStatusLabel({ flavor: 'pi', effort: 'minimal' })).toBe('minimal')
            expect(formatReasoningStatusLabel({ flavor: 'pi', effort: 'xhigh' })).toBe('xhigh')
        })
    })

    describe('grok', () => {
        it('shows default placeholder for null/empty', () => {
            expect(formatReasoningStatusLabel({ flavor: 'grok', effort: null })).toBe('default')
            expect(formatReasoningStatusLabel({ flavor: 'grok', effort: undefined })).toBe('default')
        })

        it('uses option.name when value matches grokOptions', () => {
            expect(
                formatReasoningStatusLabel({ flavor: 'grok', effort: 'think-high', grokOptions: [{ value: 'think-high', name: 'Think High' }] })
            ).toBe('Think High')
        })

        it('falls back to raw wire id when no option matches (no title-casing)', () => {
            expect(formatReasoningStatusLabel({ flavor: 'grok', effort: 'think-high' })).toBe('think-high')
            expect(formatReasoningStatusLabel({ flavor: 'grok', effort: 'think-high', grokOptions: [] })).toBe('think-high')
        })
    })

    describe('cursor / unknown', () => {
        it('returns null (do not render)', () => {
            expect(formatReasoningStatusLabel({ flavor: 'cursor', effort: 'high' })).toBeNull()
            expect(formatReasoningStatusLabel({ flavor: 'cursor', modelReasoningEffort: 'high' })).toBeNull()
            expect(formatReasoningStatusLabel({ flavor: 'something-else', effort: 'high' })).toBeNull()
            expect(formatReasoningStatusLabel({ flavor: null })).toBeNull()
            expect(formatReasoningStatusLabel({ flavor: undefined })).toBeNull()
        })
    })
})
