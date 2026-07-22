import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ArchiveBlockerError } from '@/api/client'
import { ArchiveBlockerDialog } from './ArchiveBlockerDialog'

afterEach(() => cleanup())

describe('ArchiveBlockerDialog', () => {
    it('offers the destructive continuation only after a blocker exists', () => {
        const onConfirm = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
        render(
            <I18nProvider>
                <ArchiveBlockerDialog
                    blocker={new ArchiveBlockerError('Worktree has uncommitted changes.', 'dirty_worktree', 'cleanup')}
                    onClose={vi.fn()}
                    onConfirm={onConfirm}
                    isPending={false}
                />
            </I18nProvider>
        )

        expect(screen.getByText(/Worktree has uncommitted changes/)).toBeInTheDocument()
        const continueButton = screen.getByRole('button', { name: 'Continue archive' })
        fireEvent.click(continueButton)
        expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('explains that offline continuation leaves the worktree in place', () => {
        render(
            <I18nProvider>
                <ArchiveBlockerDialog
                    blocker={new ArchiveBlockerError('Session runner is offline.', 'machine_offline', 'archive-only')}
                    onClose={vi.fn()}
                    onConfirm={vi.fn().mockResolvedValue(undefined)}
                    isPending={false}
                />
            </I18nProvider>
        )

        expect(screen.getByText(/leave the local worktree in place/i)).toBeInTheDocument()
    })
})
