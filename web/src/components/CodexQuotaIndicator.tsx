import { useEffect, useId, useRef, useState } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import type { CodexQuotaPresentation, CodexQuotaWindowPresentation } from '@/lib/machineHealth'
import { MACHINE_HEALTH_BAR_FILL_CLASS, MACHINE_HEALTH_CHIP_CLASS } from '@/lib/machineHealth'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function QuotaBar(props: { label: string; window: CodexQuotaWindowPresentation | null }) {
    return (
        <span className="inline-flex items-center gap-0.5">
            <span className="w-5 shrink-0 text-[8px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.label}
            </span>
            <span className="relative h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]/80" aria-hidden="true">
                <span
                    className={cn(
                        'block h-full rounded-full',
                        MACHINE_HEALTH_BAR_FILL_CLASS[props.window?.tone ?? 'unknown']
                    )}
                    style={{ width: `${props.window?.remainingPercent ?? 0}%` }}
                />
                {!props.window ? (
                    <span className="absolute inset-0 text-center text-[8px] leading-[6px] text-[var(--app-hint)]">—</span>
                ) : null}
            </span>
        </span>
    )
}

function formatDateTime(timestamp: number, unit: 'seconds' | 'milliseconds'): string {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(unit === 'seconds' ? timestamp * 1000 : timestamp))
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
    const overallTone = presentation.status === 'error'
        ? 'unknown'
        : presentation.fiveHour?.tone === 'critical' || presentation.weekly?.tone === 'critical'
            ? 'critical'
            : presentation.fiveHour?.tone === 'warn' || presentation.weekly?.tone === 'warn'
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
            fiveHour: presentation.fiveHour?.remainingPercent ?? '—',
            weekly: presentation.weekly?.remainingPercent ?? '—'
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
                    <QuotaBar label="5H" window={presentation.fiveHour} />
                    <QuotaBar label="W" window={presentation.weekly} />
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
                            <span className="text-[var(--app-hint)]">{t('machine.quota.fiveHour')}</span>
                            <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                                {presentation.fiveHour ? `${presentation.fiveHour.remainingPercent}%` : '—'}
                            </span>
                        </span>
                        {presentation.fiveHour ? (
                            <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                                <span>{t('machine.quota.reset')}</span>
                                <span>{formatDateTime(presentation.fiveHour.resetAt, 'seconds')}</span>
                            </span>
                        ) : null}
                        <span className="flex justify-between gap-3">
                            <span className="text-[var(--app-hint)]">{t('machine.quota.weekly')}</span>
                            <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                                {presentation.weekly ? `${presentation.weekly.remainingPercent}%` : '—'}
                            </span>
                        </span>
                        {presentation.weekly ? (
                            <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                                <span>{t('machine.quota.reset')}</span>
                                <span>{formatDateTime(presentation.weekly.resetAt, 'seconds')}</span>
                            </span>
                        ) : null}
                    </>
                )}
                <span className="flex justify-between gap-3 text-[var(--app-hint)]">
                    <span>{t('machine.quota.nextRefresh')}</span>
                    <span>{formatDateTime(presentation.nextRefreshAt, 'milliseconds')}</span>
                </span>
            </span>
        </HoverTooltip>
    )
}
