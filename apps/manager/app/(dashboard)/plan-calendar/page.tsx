'use client';

import { humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanCalendarEntry } from '@/lib/queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The planned work due across every plan (ADR 0076): the dates already
 * generated, with their status and work order, and the ones still to come.
 * Up to 93 days at a time.
 */
export default function PlanCalendarPage() {
  const { ready, can } = usePermissions();
  const allowed = can('assets.read');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date(Date.now() + 30 * 24 * 3_600_000)));
  const calendar = useQuery({
    queryKey: keys.planCalendar(from, to),
    queryFn: () => fetchers.planCalendar(from, to),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Planned work calendar" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Planned work calendar"
        description="Every plan’s dates in the period: those already opened as work orders, and those still to come."
      />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To" hint="At most 93 days after From.">
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={calendar}>
          <DataTable<PlanCalendarEntry>
            rows={calendar.data?.data ?? []}
            rowKey={(e) => `${e.planId}:${e.dueOn}`}
            empty="No planned work in this period"
            columns={[
              {
                key: 'due',
                header: 'Due',
                cell: (e) => (
                  <>
                    <span className="t-mono">{e.dueOn}</span>
                    {/* ADR 0084: a holiday flags the date; it is not moved. */}
                    {e.holiday ? (
                      <>
                        {' '}
                        <Badge tone="terracotta">Holiday · {e.holiday.nameEn}</Badge>
                      </>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'asset',
                header: 'Asset',
                cell: (e) => (
                  <Link className="table__link" href={`/assets/${e.assetId}`}>
                    {e.assetCode}
                  </Link>
                ),
              },
              { key: 'title', header: 'Work', cell: (e) => e.title },
              { key: 'priority', header: 'Priority', cell: (e) => humanize(e.priority) },
              {
                key: 'status',
                header: 'Status',
                cell: (e) => (e.status === 'projected' ? <Badge plain>To come</Badge> : <Badge>{humanize(e.status)}</Badge>),
              },
              {
                key: 'ticket',
                header: 'Work order',
                cell: (e) =>
                  e.ticketId ? (
                    <Link className="table__link" href={`/maintenance/${e.ticketId}`}>
                      Open
                    </Link>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
