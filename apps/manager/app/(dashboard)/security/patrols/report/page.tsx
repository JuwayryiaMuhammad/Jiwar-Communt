'use client';

import { QueryState } from '@jiwar/api/react';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { addDays, postName, today } from '@/components/security/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolReport } from '@/lib/queries';

type Row = PatrolReport['routes'][number];

/** The patrol report (ADR 0052): per route over a period. */
export default function PatrolReportPage() {
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage') || can('guard_reports.read');
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const report = useQuery({
    queryKey: keys.patrolReport({ from, to }),
    queryFn: () => fetchers.patrolReport({ from, to }),
    enabled: allowed && from !== '' && to !== '',
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Patrol report" />
        <ForbiddenState />
      </>
    );
  const n = (v: number) => <span className="t-num">{v}</span>;
  return (
    <>
      <PageHeader title="Patrol report" description="Per route, the runs planned in the period: 31 days at most. The daily report counts each post’s patrols too." />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={report}>
          <DataTable<Row>
            rows={report.data?.routes}
            rowKey={(r) => r.route.id}
            empty="No run in the period"
            columns={[
              { key: 'route', header: 'Route', cell: (r) => <span className="table__primary">{r.route.nameEn}</span> },
              { key: 'post', header: 'Post', cell: (r) => postName(r.post) },
              { key: 'scheduled', header: 'Scheduled', cell: (r) => n(r.scheduled) },
              { key: 'adhoc', header: 'Unscheduled', cell: (r) => n(r.adhoc) },
              { key: 'done', header: 'Done', cell: (r) => n(r.done) },
              { key: 'late', header: 'Late', cell: (r) => n(r.late) },
              { key: 'missed', header: 'Missed', cell: (r) => n(r.missed) },
              { key: 'incomplete', header: 'Incomplete', cell: (r) => n(r.incomplete) },
              { key: 'manual', header: 'By hand', cell: (r) => n(r.manualScans) },
              { key: 'suspect', header: 'Far', cell: (r) => n(r.suspectScans) },
              { key: 'offline', header: 'Sent late', cell: (r) => n(r.lateScans) },
              { key: 'avg', header: 'Avg minutes', cell: (r) => (r.avgMinutes ?? '—') },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
