'use client';

import { formatDate, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceCalendar } from '@/lib/queries';

type Entry = ComplianceCalendar['entries'][number];

/**
 * The compliance calendar (ADR 0087): the items' due days and the vendors'
 * papers expiring, by day; 90 days by default, a year at most.
 */
export default function ComplianceCalendarPage() {
  const { ready, can } = usePermissions();
  const allowed = can('compliance.manage');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const cal = useQuery({ queryKey: keys.complianceCalendar(period), queryFn: () => fetchers.complianceCalendar(period), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Compliance calendar" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Compliance calendar" description="What falls due, and the vendors’ papers that expire, day by day." />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={cal}>
          <DataTable<Entry>
            rows={cal.data?.entries ?? []}
            rowKey={(e) => e.id}
            empty="Nothing falls due"
            columns={[
              { key: 'd', header: 'Day', cell: (e) => formatDate(e.day) },
              {
                key: 'w',
                header: 'What',
                cell: (e) =>
                  e.source === 'compliance' && e.itemId ? (
                    <Link className="table__link" href={`/compliance/${e.itemId}`}>
                      {e.title}
                    </Link>
                  ) : e.vendorId ? (
                    <Link className="table__link" href={`/vendors/${e.vendorId}`}>
                      {e.vendorName} · {humanize(e.kind)} paper
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'k', header: 'Kind', cell: (e) => humanize(e.kind) },
              { key: 's', header: 'State', cell: (e) => humanize(e.state) },
            ]}
          />
          {cal.data?.truncated ? <p className="t-secondary">More than 1000 entries: ask for fewer days.</p> : null}
        </QueryState>
      </Card>
    </>
  );
}
