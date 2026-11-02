'use client';

import { humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The ratings report and the promises against their targets (ADR 0082),
 * over the compound's days: never who rated, never a comment. The board
 * reads the same totals in its overview and its monthly report.
 */
export default function ExperienceReportsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const ratings = useQuery({ queryKey: keys.ratingsReport(from, to), queryFn: () => fetchers.ratingsReport(from, to), enabled: allowed });
  const promises = useQuery({ queryKey: keys.promisesReport(from, to), queryFn: () => fetchers.promisesReport(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Experience reports" />
        <ForbiddenState />
      </>
    );
  const r = ratings.data;
  return (
    <>
      <PageHeader title="Experience reports" description="The ratings by source and building, why low ratings were low, the units rating low again and again, and the promises kept." />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={ratings}>
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          {(r?.bySource ?? []).map((s) => (
            <Card key={s.source}>
              <div className="stack stack--sm" style={{ padding: 12 }}>
                <span className="t-secondary">{humanize(s.source)}</span>
                <strong className="t-title-md">{s.average ?? '—'}</strong>
                <span className="t-secondary">
                  {s.count} rated · {s.low} low
                </span>
              </div>
            </Card>
          ))}
        </div>
        <h2 className="t-title-md">Why low</h2>
        <Card flush>
          <DataTable
            rows={r?.reasons ?? []}
            rowKey={(x) => x.code}
            empty="No low rating gave a reason"
            columns={[
              { key: 'code', header: 'Reason', cell: (x) => humanize(x.code) },
              { key: 'count', header: 'Ratings', cell: (x) => x.count },
              { key: 'share', header: 'Share', cell: (x) => `${x.share}%` },
            ]}
          />
        </Card>
        <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
          By building
        </h2>
        <Card flush>
          <DataTable
            rows={r?.byBuilding ?? []}
            rowKey={(x) => x.building ?? '—'}
            columns={[
              { key: 'building', header: 'Building', cell: (x) => x.building ?? 'No building' },
              { key: 'count', header: 'Rated', cell: (x) => x.count },
              { key: 'avg', header: 'Average', cell: (x) => x.average ?? '—' },
              { key: 'low', header: 'Low', cell: (x) => x.low },
            ]}
          />
        </Card>
        <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
          Units rating low again and again
        </h2>
        <Card flush>
          <DataTable
            rows={r?.units ?? []}
            rowKey={(x) => x.unitId}
            empty="None"
            columns={[
              { key: 'unit', header: 'Unit', cell: (x) => x.unitCode ?? '—' },
              { key: 'low', header: 'Low ratings', cell: (x) => x.low },
            ]}
          />
        </Card>
      </QueryState>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        Promises
      </h2>
      <QueryState query={promises}>
        <Card flush>
          <DataTable
            rows={promises.data?.items ?? []}
            rowKey={(x) => x.promise.id}
            empty="No active promise"
            columns={[
              { key: 'title', header: 'Promise', cell: (x) => x.promise.titleEn },
              { key: 'value', header: 'Measured', cell: (x) => (x.measured ? (x.value ?? 'Nothing to measure') : 'Not measured') },
              { key: 'items', header: 'Items', cell: (x) => x.items },
              { key: 'met', header: '', cell: (x) => (x.met === null ? null : <Badge>{x.met ? 'Kept' : 'Missed'}</Badge>) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
