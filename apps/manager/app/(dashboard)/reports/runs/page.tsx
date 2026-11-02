'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FORMAT_TEXT } from '@/components/reports/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReportRun } from '@/lib/queries';

const READERS = ['assets.manage', 'stock.manage', 'tickets.dispatch', 'energy.read', 'finance.reports'];

/**
 * The scheduled reports' runs (ADR 0086), of the reports the signed-in
 * account may read: each a file, kept 90 days, opened through a link that
 * lasts a few minutes.
 */
export default function ReportRunsPage() {
  const { ready, can } = usePermissions();
  const allowed = READERS.some((p) => can(p));
  const runs = useQuery({ queryKey: keys.reportRuns(), queryFn: fetchers.reportRuns, enabled: allowed });
  const [error, setError] = useState<unknown>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Sent reports" />
        <ForbiddenState />
      </>
    );
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
      <PageHeader title="Sent reports" description="Every period’s run of a scheduled report, kept for 90 days." />
      <ErrorAlert error={error} />
      <QueryState query={runs}>
        <Card flush>
          <DataTable<ReportRun>
            rows={runs.data?.data ?? []}
            rowKey={(r) => r.id}
            empty="No report was sent yet"
            columns={[
              { key: 'report', header: 'Report', cell: (r) => r.reportKey.replace(/_/g, ' ') },
              { key: 'period', header: 'Period', cell: (r) => `${r.periodFrom} – ${r.periodTo}` },
              { key: 'format', header: 'Format', cell: (r) => FORMAT_TEXT[r.format] },
              { key: 'rows', header: 'Rows', cell: (r) => r.rows },
              {
                key: 'file',
                header: '',
                cell: (r) =>
                  r.status === 'ready' ? (
                    <Button size="sm" onClick={() => void open(r)}>
                      Download
                    </Button>
                  ) : (
                    <Badge tone="beige">Expired</Badge>
                  ),
              },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
