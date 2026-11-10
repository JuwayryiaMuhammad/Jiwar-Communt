'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReportRun } from '@/lib/queries';
import ar from '@/messages/ar/ops-reports';
import en from '@/messages/en/ops-reports';

const READERS = ['assets.manage', 'stock.manage', 'tickets.dispatch', 'energy.read', 'finance.reports'];

/**
 * The scheduled reports' runs (ADR 0086), of the reports the signed-in
 * account may read: each a file, kept 90 days, opened through a link that
 * lasts a few minutes.
 */
export default function ReportRunsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = READERS.some((p) => can(p));
  const runs = useQuery({ queryKey: keys.reportRuns(), queryFn: fetchers.reportRuns, enabled: allowed });
  // The reports' titles, in both languages.
  const catalog = useQuery({ queryKey: keys.reportCatalog(), queryFn: fetchers.reportCatalog, enabled: allowed });
  const [error, setError] = useState<unknown>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('runsTitle')} />
        <ForbiddenState />
      </>
    );
  const title = (k: string) => catalog.data?.data.find((r) => r.key === k)?.title[locale] ?? k.replace(/_/g, ' ');
  const open = async (r: ReportRun) => {
    setError(null);
    try {
      const link = await unwrap(api.GET('/api/v1/staff/report-runs/{id}/download', { params: { path: { id: r.id } } }));
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <PageHeader title={t('runsTitle')} description={t('runsDescription')} />
      <ErrorAlert error={error} />
      <QueryState query={runs}>
        <Card flush>
          <DataTable<ReportRun>
            rows={runs.data?.data ?? []}
            rowKey={(r) => r.id}
            empty={t('runsEmpty')}
            columns={[
              { key: 'report', header: t('col.report'), cell: (r) => title(r.reportKey) },
              { key: 'period', header: t('col.period'), cell: (r) => t('period', { from: fmt.day(r.periodFrom), to: fmt.day(r.periodTo) }) },
              { key: 'format', header: t('col.format'), cell: (r) => t(`format.${r.format}`) },
              { key: 'rows', header: t('col.rows'), cell: (r) => fmt.number(r.rows) },
              {
                key: 'file',
                header: '',
                cell: (r) =>
                  r.status === 'ready' ? (
                    <Button size="sm" onClick={() => void open(r)}>
                      {t('download')}
                    </Button>
                  ) : (
                    <Badge tone="beige">{t('expired')}</Badge>
                  ),
              },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
