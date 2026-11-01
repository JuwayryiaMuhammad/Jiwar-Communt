'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, type BoardReport } from '@/lib/board-work';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';

/**
 * The board's monthly reports (ADR 0075): the month before is written on a
 * month's first days and the board told; any month can be drawn again, as
 * its next version. Totals only, with the compound's logo on the PDF.
 */
export default function BoardReportsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const list = useCursorList(boardWorkKeys.reports, (c) => boardWorkFetchers.reports(c), { enabled: allowed });
  const [month, setMonth] = useState('');
  const draw = useAction(() => unwrap(api.POST('/api/v1/board/reports', { body: { month } })), {
    invalidate: [boardWorkKeys.reports],
    onDone: (r) => toast.show(`Drawn: ${r.month}, version ${r.version}.`),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board reports" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Board reports" description="The board’s figures for each month, beside the money and the security overview." />
      <Card>
        <CardHeader title="Draw a month" />
        <div className="stack">
          <Field label="Month" hint="Up to the current one" error={fieldError(draw.error, 'month')}>
            {(p) => <Input {...p} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
          <ErrorAlert error={draw.error} />
          <Button variant="primary" loading={draw.isPending} disabled={!month} onClick={() => draw.mutate(undefined)}>
            Draw
          </Button>
        </div>
      </Card>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No report yet"
            columns={[
              { key: 'm', header: 'Month', cell: (r) => r.month },
              { key: 'v', header: 'Version', cell: (r) => `${r.version}${r.bySweep ? ' · monthly' : ''}` },
              { key: 'g', header: 'Written', cell: (r) => formatDateTime(r.generatedAt) },
              {
                key: 'p',
                header: '',
                cell: (r) => (
                  <Button size="sm" onClick={() => download(`/api/v1/board/reports/${r.id}/pdf`, {}, `board-report-${r.month}.pdf`)}>
                    PDF
                  </Button>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
