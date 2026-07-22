import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'
import type { ArchiveBlockerError } from '@/api/client'

type ArchiveBlockerDialogProps = {
    blocker: ArchiveBlockerError | null
    error?: string | null
    onClose: () => void
    onConfirm: () => Promise<void>
    isPending: boolean
}

export function ArchiveBlockerDialog(props: ArchiveBlockerDialogProps) {
    const { t } = useTranslation()
    const blocker = props.blocker
    const error = props.error ?? null
    if (!blocker && !error) return null

    if (!blocker) {
        return (
            <ConfirmDialog
                isOpen={true}
                onClose={props.onClose}
                title={t('dialog.archive.failedTitle')}
                description={error ?? t('dialog.error.default')}
                confirmLabel={t('button.dismiss')}
                confirmingLabel={t('button.dismiss')}
                onConfirm={async () => props.onClose()}
                isPending={false}
            />
        )
    }

    const consequence = blocker.forceMode === 'cleanup'
        ? t('dialog.archive.forceCleanupDescription')
        : t('dialog.archive.forceArchiveOnlyDescription')

    return (
        <ConfirmDialog
            isOpen={true}
            onClose={props.onClose}
            title={t('dialog.archive.blockedTitle')}
            description={`${blocker.message}\n\n${consequence}`}
            confirmLabel={t('dialog.archive.forceConfirm')}
            confirmingLabel={t('dialog.archive.confirming')}
            onConfirm={props.onConfirm}
            isPending={props.isPending}
            destructive
        />
    )
}
