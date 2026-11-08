'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, EmptyState, Field, ForbiddenState, Input, PageHeader, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { change, COMPARE_TEXT, GROUP_TEXT, NOTE_TEXT } from '@/components/reports/labels';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReportCatalogEntry, type ReportResult } from '@/lib/queries';

type Row = ReportResult['rows'][number] & { n: number };
const iso = (d: Date) => d.toLocaleDateString('en-CA');
const READERS = ['assets.manage', 'stock.manage', 'tickets.dispatch', 'energy.read', 'finance.reports'];

/**
 * The curated reports (ADR 0086): the ones the signed-in account may read,
 * over a period, grouped, compared with the period before or a year
 * earlier; drawn as a PDF, a workbook or CSV. Groups only, never a person.
 */
export default function ReportsPage() {
  const { ready, can } = usePermissions();
  const allowed = READERS.some((p) => can(p));
  const catalog = useQuery({ queryKey: keys.reportCatalog(), queryFn: fetchers.reportCatalog, enabled: allowed });
  const reports = catalog.data?.data ?? [];
  const [key, setKey] = useState<ReportCatalogEntry['key'] | ''>('');
  const def = reports.find((r) => r.key === key);
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const [groupBy, setGroupBy] = useState('');
  const [compare, setCompare] = useState<ReportResult['compare']>('none');
  const [fileError, setFileError] = useState<unknown>(null);
  useEffect(() => {
    if (!key && reports[0]) setKey(reports[0].key);
  }, [key, reports]);
  useEffect(() => setGroupBy(def?.groupBy[0] ?? ''), [def]);
  const q = key ? { report: key, from, to, groupBy: groupBy || undefined, compare } : null;
  const result = useQuery({
    queryKey: keys.staffReport(q ?? {}),
    queryFn: () => fetchers.report(q!),
    enabled: allowed && q !== null && groupBy !== '',
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Reports" />
        <ForbiddenState />
      </>
    );
  const r = result.data;
  const file = (format: 'pdf' | 'xlsx' | 'csv') =>
    q &&
    download('/api/v1/staff/reports/export', { ...q, format }, `${q.report}-${from}-${to}.${format}`).catch(setFileError);
  const rows: Row[] = (r?.rows ?? []).map((x, n) => ({ ...x, n }));
  const figure = (i: number) => r && i >= r.dimensions && r.columns[i]?.kind !== 'text';
  return (
    <>
      <PageHeader
        title="Reports"
        description="The compound’s figures by building, asset type, item, category or month — compared with the period before or a year earlier. Groups only: never a person or a unit."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button onClick={() => file('pdf')} disabled={!q}>
              PDF
            </Button>
            <Button onClick={() => file('xlsx')} disabled={!q}>
              Excel
            </Button>
            <Button onClick={() => file('csv')} disabled={!q}>
              CSV
            </Button>
          </div>
        }
      />
      <ErrorAlert error={fileError} />
      <QueryState query={catalog}>
        {reports.length ? (
          <>
            <div className="form__row" style={{ marginBottom: 12 }}>
              <Field label="Report">
                {(p) => (
                  <Select {...p} value={key} onChange={(e) => setKey(e.target.value as ReportCatalogEntry['key'])}>
                    {reports.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.title.en}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
              <Field label="Grouped by">
                {(p) => (
                  <Select {...p} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                    {(def?.groupBy ?? []).map((g) => (
                      <option key={g} value={g}>
                        {GROUP_TEXT[g] ?? g}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Compared with">
                {(p) => (
                  <Select {...p} value={compare} onChange={(e) => setCompare(e.target.value as ReportResult['compare'])}>
                    {Object.entries(COMPARE_TEXT).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <QueryState query={result}>
              {r ? (
                <Card flush>
                  <DataTable<Row>
                    rows={[...rows, { ...r.totals, n: -1 }]}
                    rowKey={(x) => String(x.n)}
                    empty="Nothing in this period"
                    columns={r.columns.map((c, i) => ({
                      key: c.key,
                      header: c.en,
                      cell: (x: Row) => {
                        const v = x.values[i];
                        const shown = c.key === 'note' && v ? (NOTE_TEXT[v] ?? v) : (v ?? '—');
                        if (!figure(i) || r.compare === 'none') return x.n === -1 ? <strong>{shown}</strong> : shown;
                        const parts = [
                          r.previousPeriod ? `before ${x.previous?.[i] ?? '—'} (${change(v ?? null, x.previous?.[i] ?? null) ?? '—'})` : null,
                          r.lastYearPeriod ? `a year ago ${x.lastYear?.[i] ?? '—'} (${change(v ?? null, x.lastYear?.[i] ?? null) ?? '—'})` : null,
                        ].filter(Boolean);
                        return (
                          <div className="stack stack--sm">
                            <span>{x.n === -1 ? <strong>{shown}</strong> : shown}</span>
                            <span className="t-secondary">{parts.join(' · ')}</span>
                          </div>
                        );
                      },
                    }))}
                  />
                </Card>
              ) : null}
            </QueryState>
          </>
        ) : (
          <EmptyState title="No report for your role">Each report is read with its own permission.</EmptyState>
        )}
      </QueryState>
    </>
  );
}
