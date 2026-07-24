import { useEffect, useId, useRef, useState } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import type { CodexQuotaPresentation, CodexQuotaWindowPresentation } from '@/lib/machineHealth'
import { MACHINE_HEALTH_BAR_FILL_CLASS, MACHINE_HEALTH_CHIP_CLASS } from '@/lib/machineHealth'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function QuotaBar(props: { label: string; percent: number | null; tone: CodexQuotaWindowPresentation['tone'] }) {
    return (
        <span className="inline-flex items-center gap-0.5">
            <span className="w-5 shrink-0 text-[8px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.label}
            </span>
            <span className="relative h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]/80" aria-hidden="true">
                <span
                    className={cn(
                        'block h-full rounded-full',
                        MACHINE_HEALTH_BAR_FILL_CLASS[props.tone]
                    )}
                    style={{ width: `${props.percent ?? 0}%` }}
                />
                {props.percent === null ? (
                    <span className="absolute inset-0 text-center text-[8px] leading-[6px] text-[var(--app-hint)]">—</span>
                ) : null}
            </span>
        </span>
    )
}

function formatResetAt(timestampSeconds: number): string {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(timestampSeconds * 1000))
}

function formatCountdown(seconds: number): string {
    const totalMinutes = Math.max(0, Math.ceil(seconds / 60))
    const days = Math.floor(totalMinutes / (24 * 60))
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
    const minutes = totalMinutes % 60
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
}

export function CodexQuotaIndicator(props: {
    presentation: CodexQuotaPresentation
    className?: string
}) {
    const { t } = useTranslation()
    const tooltipId = useId()
    const [clickOpen, setClickOpen] = useState(false)
    const containerRef = useRef<HTMLSpanElement>(null)
    const { presentation } = props
    const [now, setNow] = useState(() => Date.now())
    const weekly = presentation.weekly
    useEffect(() => {
        if (!weekly) return
        const timer = window.setInterval(() => setNow(Date.now()), 60_000)
        return () => window.clearInterval(timer)
    }, [weekly?.resetAt])
    const resetSeconds = weekly ? Math.max(0, weekly.resetAt - now / 1000) : null
    const resetPercent = weekly && resetSeconds !== null
        ? Math.max(0, Math.min(100, resetSeconds / weekly.windowSeconds * 100))
        : null
    const overallTone = presentation.status === 'error'
        ? 'unknown'
        : presentation.weekly?.tone === 'critical'
            ? 'critical'
            : presentation.weekly?.tone === 'warn'
                ? 'warn'
                : 'ok'

    useEffect(() => {
        if (!clickOpen) return
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setClickOpen(false)
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }, [clickOpen])

    const ariaLabel = presentation.status === 'error'
        ? t('machine.quota.aria.error')
        : t('machine.quota.aria.summary', {
            weekly: presentation.weekly?.remainingPercent ?? '—',
            reset: resetSeconds === null ? '—' : formatCountdown(resetSeconds),
            resets: presentation.resetCredits?.availableCount ?? '—'
        })

    const chip = (
        <button
            type="button"
            className={cn(
                'inline-flex flex-row flex-nowrap items-center gap-x-1 rounded-md border px-1 py-0.5',
                MACHINE_HEALTH_CHIP_CLASS[overallTone],
                props.className
            )}
            aria-label={ariaLabel}
            aria-describedby={tooltipId}
            aria-expanded={clickOpen}
            aria-controls={tooltipId}
            onClick={(event) => {
                event.stopPropagation()
                setClickOpen((open) => !open)
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') setClickOpen(false)
            }}
        >
            {presentation.status === 'error' ? (
                <span className="text-[10px] text-[var(--app-hint)]">{t('machine.quota.queryFailedShort')}</span>
            ) : (
                <>
                    <QuotaBar label="W" percent={presentation.weekly?.remainingPercent ?? null} tone={presentation.weekly?.tone ?? 'unknown'} />
                    <QuotaBar label="R" percent={resetPercent} tone="ok" />
                </>
            )}
        </button>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={chip}
            side="bottom"
            align="end"
            className="shrink-0"
            tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem]"
            open={clickOpen}
            containerRef={containerRef}
        >
            <span className="block space-y-1.5 text-[11px]">
                <span className="block font-medium text-[var(--app-fg)]">{t('machine.quota.tooltip.title')}</span>
                {presentation.status === 'error' ? (
                    <span className="block text-[var(--app-hint)]">{t('machine.quota.tooltip.queryFailed')}</span>
                ) : (
                    <>
                        <span className="flex justify-between gap-3">
                            <span className="text-[var(--app-hint)]">{t('machine.quota.weekly')}</span>
                            <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                                {weekly ? `${weekly.remainingPercent}%` : '—'}
                            </span>
                        </span>
                        {weekly ? (
                            <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                                <span>{t('machine.quota.resetCountdown')}</span>
                                <span>{resetSeconds === null ? '—' : formatCountdown(resetSeconds)}</span>
                            </span>
                        ) : null}
                        {weekly ? (
                            <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                                <span>{t('machine.quota.reset')}</span>
                                <span>{formatResetAt(weekly.resetAt)}</span>
                            </span>
                        ) : null}
                        <span className="flex justify-between gap-3">
                            <span className="text-[var(--app-hint)]">{t('machine.quota.resetCredits')}</span>
                            <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                                {presentation.resetCredits?.status === 'ok'
                                    ? `${presentation.resetCredits.availableCount ?? 0}`
                                    : '—'}
                            </span>
                        </span>
                        {presentation.resetCredits?.status === 'ok' && presentation.resetCredits.nextExpiresAt ? (
                            <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                                <span>{t('machine.quota.nextResetExpiry')}</span>
                                <span>{formatResetAt(presentation.resetCredits.nextExpiresAt / 1000)}</span>
                            </span>
                        ) : null}
                    </>
                )}
            </span>
        </HoverTooltip>
    )
}
