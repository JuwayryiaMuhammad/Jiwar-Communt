'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SlaReport } from '@/lib/queries';

type Row = SlaReport['rows'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 1000) / 10}%`);

/** Whether the SLA was kept over a period (ADR 0076), for the dispatch. */
export default function SlaReportPage() {
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const report = useQuery({ queryKey: keys.slaReport(from, to), queryFn: () => fetchers.slaReport(from, to), enabled: allowed });
  const [csvError, setCsvError] = useState<unknown>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="SLA report" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="SLA report"
        description="The clocks that ended met or breached over the period, by category, priority and clock. A clock stopped by the SLA being turned off is no verdict."
        actions={
          <Button onClick={() => download('/api/v1/maintenance/sla-report/export', { from, to }, `sla-${from}-${to}.csv`).catch(setCsvError)}>
            Export CSV
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          {(report.data?.totals ?? []).map((t) => (
            <Card key={t.clock}>
              <div className="stack stack--sm" style={{ padding: 12 }}>
                <span className="t-secondary">{t.clock === 'response' ? 'Response' : 'Resolution'}</span>
                <strong className="t-title-md">{pct(t.metRate)}</strong>
                <span className="t-secondary">
                  {t.met} met · {t.breached} breached
                </span>
              </div>
            </Card>
          ))}
        </div>
        <Card flush>
          <DataTable<Row>
            rows={report.data?.rows ?? []}
            rowKey={(r) => `${r.categoryKey}:${r.priority}:${r.clock}`}
            empty="No clock ended in this period"
            columns={[
              { key: 'category', header: 'Category', cell: (r) => r.categoryKey },
              { key: 'priority', header: 'Priority', cell: (r) => r.priority },
              { key: 'clock', header: 'Clock', cell: (r) => r.clock },
              { key: 'met', header: 'Met', cell: (r) => r.met },
              { key: 'breached', header: 'Breached', cell: (r) => r.breached },
              { key: 'rate', header: 'Met share', cell: (r) => pct(r.metRate) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
