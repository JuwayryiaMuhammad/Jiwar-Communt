'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CADENCE_TEXT, COMPARE_TEXT, FORMAT_TEXT, GROUP_TEXT } from '@/components/reports/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReportCatalogEntry, type ReportSchedule } from '@/lib/queries';

type Cadence = 'daily' | 'weekly' | 'monthly';
type Format = 'pdf' | 'xlsx' | 'csv';
type Compare = 'none' | 'previous' | 'last_year' | 'both';

/**
 * Reports sent on a cadence (ADR 0086): each period's run is written once,
 * and the staff who may read the report are told it is ready — the file
 * is downloaded from "Sent reports", never carried in the notice.
 */
export default function ReportSchedulesPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('reports.schedule');
  const list = useQuery({ queryKey: keys.reportSchedules(), queryFn: fetchers.reportSchedules, enabled: allowed });
  const catalog = useQuery({ queryKey: keys.reportCatalog(), queryFn: fetchers.reportCatalog, enabled: allowed });
  const reports = catalog.data?.data ?? [];
  const [reportKey, setReportKey] = useState<ReportCatalogEntry['key'] | ''>('');
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [format, setFormat] = useState<Format>('pdf');
  const [compare, setCompare] = useState<Compare>('previous');
  const [groupBy, setGroupBy] = useState('');
  const def = reports.find((r) => r.key === reportKey);
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/report-schedules', {
          body: { reportKey: reportKey as ReportCatalogEntry['key'], cadence, format, compare, ...(groupBy ? { groupBy } : {}) },
        }),
      ),
    { invalidate: [keys.reportsAll], onDone: () => toast.show('Scheduled. The first run comes after its first whole period.') },
  );
  const toggle = useAction(
    (s: ReportSchedule) =>
      unwrap(api.PATCH('/api/v1/staff/report-schedules/{id}', { params: { path: { id: s.id } }, body: { active: !s.active } })),
    { invalidate: [keys.reportsAll] },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Scheduled reports" />
        <ForbiddenState />
      </>
    );
  const title = (k: string) => reports.find((r) => r.key === k)?.title.en ?? k.replace(/_/g, ' ');
  return (
    <>
      <PageHeader
        title="Scheduled reports"
        description="A report sent daily, weekly or monthly to the staff who may read it, once per period."
      />
      <Card>
        <div className="form__row" style={{ padding: 12 }}>
          <Field label="Report" error={fieldError(create.error, 'reportKey')}>
            {(p) => (
              <Select
                {...p}
                value={reportKey}
                onChange={(e) => {
                  setReportKey(e.target.value as ReportCatalogEntry['key']);
                  setGroupBy('');
                }}
              >
                <option value="">Choose a report</option>
                {reports.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title.en}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cadence">
            {(p) => (
              <Select {...p} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {Object.entries(CADENCE_TEXT).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Format">
            {(p) => (
              <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                {Object.entries(FORMAT_TEXT).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Compared with">
            {(p) => (
              <Select {...p} value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
                {Object.entries(COMPARE_TEXT).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Grouped by" error={fieldError(create.error, 'groupBy')}>
            {(p) => (
              <Select {...p} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="">The report’s own</option>
                {(def?.groupBy ?? []).map((g) => (
                  <option key={g} value={g}>
                    {GROUP_TEXT[g] ?? g}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="primary" disabled={!reportKey} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            Schedule
          </Button>
        </div>
        <ErrorAlert error={create.error} />
      </Card>
      <QueryState query={list}>
        <Card flush>
          <DataTable<ReportSchedule>
            rows={list.data?.data ?? []}
            rowKey={(s) => s.id}
            empty="No report is scheduled"
            columns={[
              { key: 'report', header: 'Report', cell: (s) => title(s.reportKey) },
              { key: 'cadence', header: 'Cadence', cell: (s) => CADENCE_TEXT[s.cadence] },
              { key: 'format', header: 'Format', cell: (s) => FORMAT_TEXT[s.format] },
              { key: 'compare', header: 'Compared with', cell: (s) => COMPARE_TEXT[s.compare] },
              { key: 'state', header: 'State', cell: (s) => <Badge tone={s.active ? 'green' : 'beige'}>{s.active ? 'Sending' : 'Paused'}</Badge> },
              {
                key: 'act',
                header: '',
                cell: (s) => (
                  <Button size="sm" onClick={() => toggle.mutate(s)} loading={toggle.isPending}>
                    {s.active ? 'Pause' : 'Resume'}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
