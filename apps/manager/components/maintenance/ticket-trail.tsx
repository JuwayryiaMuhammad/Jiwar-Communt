'use client';

import { unwrap } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, CardHeader, Segmented, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/maint-thread';
import en from '@/messages/en/maint-thread';
import { useTicketWords, type TicketPerson } from './sla';

const VIEWS = ['status', 'assignment', 'sla', 'visits'] as const;
type View = (typeof VIEWS)[number];

interface Entry {
  key: string;
  at: string;
  title: ReactNode;
  meta?: ReactNode;
  warn?: boolean;
}

function Timeline({ entries, empty }: { entries: Entry[]; empty: string }) {
  const f = useFormat();
  if (!entries.length)
    return (
      <p className="t-secondary" style={{ padding: 16 }}>
        {empty}
      </p>
    );
  return (
    <ol className="timeline">
      {entries.map((e) => (
        <li key={e.key} className={`timeline__item${e.warn ? ' timeline__item--warn' : ''}`}>
          <div className="timeline__title">{e.title}</div>
          <div className="timeline__meta">
            {f.dateTime(e.at)}
            {e.meta ? <> · {e.meta}</> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * What happened to the ticket, one trail at a time: its statuses, who had
 * it and what auto-dispatch tried, the SLA clocks' events, and the visits'.
 * Each is read only when opened.
 */
export function TicketTrail({ ticketId }: { ticketId: string }) {
  const t = useT(en, ar);
  const label = useLabel();
  const words = useTicketWords();
  const [view, setView] = useState<View>('status');
  const path = { params: { path: { id: ticketId } } };
  const part = (name: string) => keys.ticketPart(ticketId, name);

  const who = (p: TicketPerson) => (p ? words.person(p) : t('theSystem'));
  const reason = (code: string | null | undefined) => (code ? label(code) : null);
  const minutesText = (minutes: number): string => {
    if (minutes % 1440 === 0) return t('days', { n: minutes / 1440 });
    if (minutes % 60 === 0) return t('hours', { n: minutes / 60 });
    return t('minutes', { n: minutes });
  };

  const history = useQuery({
    queryKey: part('history'),
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/history', path)),
    enabled: view === 'status',
  });
  const assignments = useQuery({
    queryKey: part('assignments'),
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/assignments', path)),
    enabled: view === 'assignment',
  });
  const attempts = useQuery({
    queryKey: part('dispatch-attempts'),
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/dispatch-attempts', path)),
    enabled: view === 'assignment',
  });
  const slaEvents = useQuery({
    queryKey: part('sla-events'),
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/sla-events', path)),
    enabled: view === 'sla',
  });
  const visitEvents = useQuery({
    queryKey: part('visit-events'),
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/visit-events', path)),
    enabled: view === 'visits',
  });

  const byTime = (entries: Entry[]) => [...entries].sort((a, b) => a.at.localeCompare(b.at));

  let body: ReactNode;
  if (view === 'status') {
    body = (
      <QueryState query={history} rows={3}>
        <Timeline
          empty={t('noStatusChange')}
          entries={(history.data?.data ?? []).map((h, i) => ({
            key: `${h.at}-${i}`,
            at: h.at,
            title: h.fromStatus
              ? t('transition', { from: label(h.fromStatus), to: label(h.toStatus) })
              : t('openedAs', { status: label(h.toStatus).toLowerCase() }),
            meta: [t('by', { name: who(h.actor) }), reason(h.reasonCode), h.cycle > 1 ? t('cycle', { n: h.cycle }) : null]
              .filter(Boolean)
              .join(' · '),
            warn: h.toStatus === 'cancelled' || h.fromStatus === 'closed',
          }))}
        />
      </QueryState>
    );
  } else if (view === 'assignment') {
    body = (
      <QueryState
        query={{ isPending: assignments.isPending || attempts.isPending, error: assignments.error ?? attempts.error }}
        rows={3}
      >
        <Timeline
          empty={t('noAssignment')}
          entries={byTime([
            ...(assignments.data?.data ?? []).map((a, i) => ({
              key: `a-${a.at}-${i}`,
              at: a.at,
              title:
                a.type === 'declined'
                  ? t('declinedBy', { name: who(a.from) })
                  : a.type === 'released'
                    ? t('releasedBy', { name: who(a.from) })
                    : a.from
                      ? t('transition', { from: who(a.from), to: who(a.to) })
                      : t('assignedTo', { name: who(a.to) }),
              meta: [label(a.type), a.by ? t('by', { name: words.person(a.by) }) : null, reason(a.reasonCode)].filter(Boolean).join(' · '),
              warn: a.type === 'declined' || a.type === 'released',
            })),
            ...(attempts.data?.data ?? []).map((d, i) => ({
              key: `d-${d.at}-${i}`,
              at: d.at,
              title:
                d.outcome === 'assigned'
                  ? t('autoChose', { name: who(d.technician) })
                  : d.outcome === 'no_candidate'
                    ? t('autoNone')
                    : t('autoSkipped'),
              meta: [
                t('trigger', { trigger: d.trigger }),
                t('candidates', { n: d.candidateCount }),
                reason(d.reasonCode),
                d.notified ? t('dispatchersTold') : null,
              ]
                .filter(Boolean)
                .join(' · '),
              warn: d.outcome === 'no_candidate',
            })),
          ])}
        />
      </QueryState>
    );
  } else if (view === 'sla') {
    body = (
      <QueryState query={slaEvents} rows={3}>
        <Timeline
          empty={t('noSlaEvent')}
          entries={byTime(
            (slaEvents.data?.data ?? []).map((e) => ({
              key: `${e.cycle}-${e.clock}-${e.seq}`,
              at: e.at,
              title: t('slaEvent', { clock: e.clock, kind: label(e.kind) }),
              meta: [t('target', { value: minutesText(e.targetMinutes) }), reason(e.reasonCode), e.cycle > 1 ? t('cycle', { n: e.cycle }) : null]
                .filter(Boolean)
                .join(' · '),
              warn: e.kind === 'breached',
            })),
          )}
        />
      </QueryState>
    );
  } else {
    body = (
      <QueryState query={visitEvents} rows={3}>
        <Timeline
          empty={t('noVisitEvent')}
          entries={(visitEvents.data?.data ?? []).map((e, i) => ({
            key: `${e.at}-${i}`,
            at: e.at,
            title: label(e.kind),
            meta: [e.actor ? t('actor', { name: words.person(e.actor), side: e.actorSide }) : t('side', { side: e.actorSide }), reason(e.reasonCode)]
              .filter(Boolean)
              .join(' · '),
            warn: e.kind === 'no_access' || e.kind === 'cancelled' || e.kind === 'late_notified',
          }))}
        />
      </QueryState>
    );
  }

  return (
    <Card flush>
      <CardHeader title={t('history')} />
      {/* Its own row: four tabs do not fit beside the title in the side column. */}
      <div style={{ padding: '12px 16px 0', overflowX: 'auto' }}>
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((value) => ({ value, label: t(`view.${value}`) }))}
        />
      </div>
      {body}
    </Card>
  );
}
