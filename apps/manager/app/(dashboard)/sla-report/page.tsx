'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SlaReport } from '@/lib/queries';
import ar from '@/messages/ar/sla-report';
import en from '@/messages/en/sla-report';

type Row = SlaReport['rows'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Whether the SLA was kept over a period (ADR 0076), for the dispatch. */
export default function SlaReportPage() {
  const t = useT(en, ar);
  const label = useLabel();
  const f = useFormat();
  const pct = (n: number | null) => (n === null ? '—' : f.percent(n, 1));
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const report = useQuery({ queryKey: keys.slaReport(from, to), queryFn: () => fetchers.slaReport(from, to), enabled: allowed });
  const [csvError, setCsvError] = useState<unknown>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button onClick={() => download('/api/v1/maintenance/sla-report/export', { from, to }, `sla-${from}-${to}.csv`).catch(setCsvError)}>
            {t('exportCsv')}
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          {(report.data?.totals ?? []).map((x) => (
            <Card key={x.clock}>
              <div className="stack stack--sm" style={{ padding: 12 }}>
                <span className="t-secondary">{label(x.clock)}</span>
                <strong className="t-title-md">{pct(x.metRate)}</strong>
                <span className="t-secondary">
                  {t('metBreached', { met: x.met, breached: x.breached })}
                </span>
              </div>
            </Card>
          ))}
        </div>
        <Card flush>
          <DataTable<Row>
            rows={report.data?.rows ?? []}
            rowKey={(r) => `${r.categoryKey}:${r.priority}:${r.clock}`}
            empty={t('empty')}
            columns={[
              { key: 'category', header: t('col.category'), cell: (r) => label(r.categoryKey) },
              { key: 'priority', header: t('col.priority'), cell: (r) => label(r.priority) },
              { key: 'clock', header: t('col.clock'), cell: (r) => label(r.clock) },
              { key: 'met', header: t('col.met'), cell: (r) => r.met },
              { key: 'breached', header: t('col.breached'), cell: (r) => r.breached },
              { key: 'rate', header: t('col.rate'), cell: (r) => pct(r.metRate) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
