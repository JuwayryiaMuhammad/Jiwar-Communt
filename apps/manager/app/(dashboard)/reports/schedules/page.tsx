'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CADENCES, COMPARES, FORMATS, isGroup } from '@/components/reports/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReportCatalogEntry, type ReportSchedule } from '@/lib/queries';
import ar from '@/messages/ar/ops-reports';
import en from '@/messages/en/ops-reports';

type Cadence = (typeof CADENCES)[number];
type Format = (typeof FORMATS)[number];
type Compare = (typeof COMPARES)[number];

/**
 * Reports sent on a cadence (ADR 0086): each period's run is written once,
 * and the staff who may read the report are told it is ready — the file
 * is downloaded from "Sent reports", never carried in the notice.
 */
export default function ReportSchedulesPage() {
  const t = useT(en, ar);
  const { locale } = useLocale();
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
    { invalidate: [keys.reportsAll], onDone: () => toast.show(t('scheduled')) },
  );
  const toggle = useAction(
    (s: ReportSchedule) =>
      unwrap(api.PATCH('/api/v1/staff/report-schedules/{id}', { params: { path: { id: s.id } }, body: { active: !s.active } })),
    { invalidate: [keys.reportsAll] },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('schedulesTitle')} />
        <ForbiddenState />
      </>
    );
  const title = (k: string) => reports.find((r) => r.key === k)?.title[locale] ?? k.replace(/_/g, ' ');
  return (
    <>
      <PageHeader title={t('schedulesTitle')} description={t('schedulesDescription')} />
      <Card>
        <div className="form__row" style={{ padding: 12 }}>
          <Field label={t('report')} error={fieldError(create.error, 'reportKey')}>
            {(p) => (
              <Select
                {...p}
                value={reportKey}
                onChange={(e) => {
                  setReportKey(e.target.value as ReportCatalogEntry['key']);
                  setGroupBy('');
                }}
              >
                <option value="">{t('chooseReport')}</option>
                {reports.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title[locale]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('cadence')}>
            {(p) => (
              <Select {...p} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {CADENCES.map((v) => (
                  <option key={v} value={v}>
                    {t(`cadence.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('format')}>
            {(p) => (
              <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                {FORMATS.map((v) => (
                  <option key={v} value={v}>
                    {t(`format.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('comparedWith')}>
            {(p) => (
              <Select {...p} value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
                {COMPARES.map((v) => (
                  <option key={v} value={v}>
                    {t(`compare.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('groupedBy')} error={fieldError(create.error, 'groupBy')}>
            {(p) => (
              <Select {...p} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="">{t('ownGrouping')}</option>
                {(def?.groupBy ?? []).map((g) => (
                  <option key={g} value={g}>
                    {isGroup(g) ? t(`group.${g}`) : g}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="primary" disabled={!reportKey} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('schedule')}
          </Button>
        </div>
        <ErrorAlert error={create.error} />
      </Card>
      <QueryState query={list}>
        <Card flush>
          <DataTable<ReportSchedule>
            rows={list.data?.data ?? []}
            rowKey={(s) => s.id}
            empty={t('schedulesEmpty')}
            columns={[
              { key: 'report', header: t('col.report'), cell: (s) => title(s.reportKey) },
              { key: 'cadence', header: t('col.cadence'), cell: (s) => t(`cadence.${s.cadence}`) },
              { key: 'format', header: t('col.format'), cell: (s) => t(`format.${s.format}`) },
              { key: 'compare', header: t('col.compare'), cell: (s) => t(`compare.${s.compare}`) },
              {
                key: 'state',
                header: t('col.state'),
                cell: (s) => <Badge tone={s.active ? 'green' : 'beige'}>{s.active ? t('sending') : t('paused')}</Badge>,
              },
              {
                key: 'act',
                header: '',
                cell: (s) => (
                  <Button size="sm" onClick={() => toggle.mutate(s)} loading={toggle.isPending}>
                    {s.active ? t('pause') : t('resume')}
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
