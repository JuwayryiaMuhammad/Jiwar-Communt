'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, CardHeader, Segmented } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { personName } from './sla';

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
            {formatDateTime(e.at)}
            {e.meta ? <> · {e.meta}</> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

const who = (p: Parameters<typeof personName>[0], fallback = 'the system') => (p ? personName(p) : fallback);
const reason = (code: string | null | undefined) => (code ? humanize(code) : null);

/**
 * What happened to the ticket, one trail at a time: its statuses, who had
 * it and what auto-dispatch tried, the SLA clocks' events, and the visits'.
 * Each is read only when opened.
 */
export function TicketTrail({ ticketId }: { ticketId: string }) {
  const [view, setView] = useState<View>('status');
  const path = { params: { path: { id: ticketId } } };
  const part = (name: string) => keys.ticketPart(ticketId, name);

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
          empty="No status change yet."
          entries={(history.data?.data ?? []).map((h, i) => ({
            key: `${h.at}-${i}`,
            at: h.at,
            title: h.fromStatus ? `${humanize(h.fromStatus)} → ${humanize(h.toStatus)}` : `Opened as ${humanize(h.toStatus).toLowerCase()}`,
            meta: [`by ${who(h.actor)}`, reason(h.reasonCode), h.cycle > 1 ? `cycle ${h.cycle}` : null].filter(Boolean).join(' · '),
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
          empty="Nobody has had this ticket yet, and auto-dispatch has not tried."
          entries={byTime([
            ...(assignments.data?.data ?? []).map((a, i) => ({
              key: `a-${a.at}-${i}`,
              at: a.at,
              title:
                a.type === 'declined'
                  ? `Declined by ${who(a.from)}`
                  : a.type === 'released'
                    ? `Back to the queue from ${who(a.from)}`
                    : a.from
                      ? `${who(a.from)} → ${who(a.to)}`
                      : `Assigned to ${who(a.to)}`,
              meta: [humanize(a.type), a.by ? `by ${personName(a.by)}` : null, reason(a.reasonCode)].filter(Boolean).join(' · '),
              warn: a.type === 'declined' || a.type === 'released',
            })),
            ...(attempts.data?.data ?? []).map((d, i) => ({
              key: `d-${d.at}-${i}`,
              at: d.at,
              title:
                d.outcome === 'assigned'
                  ? `Auto-dispatch chose ${who(d.technician)}`
                  : d.outcome === 'no_candidate'
                    ? 'Auto-dispatch found no technician'
                    : 'Auto-dispatch skipped it',
              meta: [
                `after ${humanize(d.trigger).toLowerCase()}`,
                `${d.candidateCount} candidate${d.candidateCount === 1 ? '' : 's'}`,
                reason(d.reasonCode),
                d.notified ? 'dispatchers told' : null,
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
          empty="No SLA event: the compound was not measuring an SLA for this ticket."
          entries={byTime(
            (slaEvents.data?.data ?? []).map((e) => ({
              key: `${e.cycle}-${e.clock}-${e.seq}`,
              at: e.at,
              title: `${humanize(e.clock)} clock ${e.kind}`,
              meta: [`target ${formatMinutes(e.targetMinutes)}`, reason(e.reasonCode), e.cycle > 1 ? `cycle ${e.cycle}` : null]
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
          empty="No visit event yet."
          entries={(visitEvents.data?.data ?? []).map((e, i) => ({
            key: `${e.at}-${i}`,
            at: e.at,
            title: humanize(e.kind),
            meta: [e.actor ? `${personName(e.actor)} (${e.actorSide})` : `the ${e.actorSide}`, reason(e.reasonCode)]
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
      <CardHeader title="History" />
      {/* Its own row: four tabs do not fit beside the title in the side column. */}
      <div style={{ padding: '12px 16px 0', overflowX: 'auto' }}>
        <Segmented<View>
          label="History shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'status', label: 'Status' },
            { value: 'assignment', label: 'Assignment' },
            { value: 'sla', label: 'SLA' },
            { value: 'visits', label: 'Visits' },
          ]}
        />
      </div>
      {body}
    </Card>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
