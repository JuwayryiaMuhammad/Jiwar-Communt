'use client';

import { useFormat, useT } from '@jiwar/i18n';
import { Badge, useLabel } from '@jiwar/ui';
import { useMemo } from 'react';
import type { Ticket, TicketPriority } from '@/lib/queries';
import ar from '@/messages/ar/maint-common';
import en from '@/messages/en/maint-common';

/** A person in a ticket's views. */
export type TicketPerson = { fullName?: string | null; erased?: boolean } | null | undefined;

/**
 * A ticket's words, in the page's language: a person (a name, or what is
 * left of an erased account), and where the ticket is (the unit and room,
 * or the common area).
 */
export function useTicketWords() {
  const t = useT(en, ar);
  const label = useLabel();
  return useMemo(
    () => ({
      person: (p: TicketPerson): string => {
        if (!p) return '—';
        return p.erased ? t('erased') : (p.fullName ?? '—');
      },
      place: (tk: Pick<Ticket, 'unit' | 'unitLocation' | 'commonArea'>): string => {
        if (tk.unit)
          return tk.unitLocation
            ? t('place.unitRoom', { code: tk.unit.code, room: label(tk.unitLocation) })
            : t('place.unit', { code: tk.unit.code });
        return tk.commonArea ? t('place.commonNamed', { area: tk.commonArea }) : t('place.common');
      },
    }),
    [t, label],
  );
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const label = useLabel();
  if (priority === 'emergency') return <Badge tone="error">{label('emergency')}</Badge>;
  if (priority === 'urgent') return <Badge tone="terracotta">{label('urgent')}</Badge>;
  return <span className="t-secondary">{label('normal')}</span>;
}

/** The commitment that comes due first, while its clock runs. */
function nextDue(sla: NonNullable<Ticket['sla']>): { clock: 'response' | 'resolution'; at: string } | null {
  const due = [
    sla.responseDueAt ? { clock: 'response' as const, at: sla.responseDueAt } : null,
    sla.resolutionDueAt ? { clock: 'resolution' as const, at: sla.resolutionDueAt } : null,
  ].filter((d): d is { clock: 'response' | 'resolution'; at: string } => d !== null);
  return due.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

/**
 * A ticket's SLA at a glance, as the API says it: overdue (late and still
 * unmet), paused, or when the next commitment is due; and whether a resident
 * escalated it in this cycle. Nothing while the compound measures no SLA.
 */
export function SlaBadges({ ticket }: { ticket: Pick<Ticket, 'sla' | 'escalatedAt'> }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { sla, escalatedAt } = ticket;
  if (!sla && !escalatedAt) return <span className="t-secondary">—</span>;
  const due = sla ? nextDue(sla) : null;
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'inherit' }}>
      {sla?.overdue ? <Badge tone="error">{t('overdue')}</Badge> : null}
      {sla?.paused ? <Badge tone="beige">{t('paused')}</Badge> : null}
      {sla && !sla.overdue && due ? (
        <span className="t-secondary" title={t(`dueTitle.${due.clock}`, { when: fmt.dateTime(due.at) })}>
          {t(`due.${due.clock}`, { when: fmt.relative(due.at) })}
        </span>
      ) : null}
      {sla && !sla.overdue && !sla.paused && !due ? <span className="t-secondary">{t('onTime')}</span> : null}
      {escalatedAt ? (
        <span title={t('escalatedTitle', { when: fmt.dateTime(escalatedAt) })}>
          <Badge tone="terracotta">{t('escalated')}</Badge>
        </span>
      ) : null}
    </span>
  );
}
