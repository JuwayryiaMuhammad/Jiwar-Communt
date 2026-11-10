'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, type BoardReport } from '@/lib/board-work';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-board-reports';
import en from '@/messages/en/gov-board-reports';

/**
 * The board's monthly reports (ADR 0075): the month before is written on a
 * month's first days and the board told; any month can be drawn again, as
 * its next version. Totals only, with the compound's logo on the PDF.
 */
export default function BoardReportsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const list = useCursorList(boardWorkKeys.reports, (c) => boardWorkFetchers.reports(c), { enabled: allowed });
  const [month, setMonth] = useState('');
  const draw = useAction(() => unwrap(api.POST('/api/v1/board/reports', { body: { month } })), {
    invalidate: [boardWorkKeys.reports],
    onDone: (r) => toast.show(t('drawn', { month: f.month(r.month), version: r.version })),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('reportsTitle')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('reportsTitle')} description={t('reportsDescription')} />
      <Card>
        <CardHeader title={t('drawTitle')} />
        <div className="stack">
          <Field label={t('month')} hint={t('monthHint')} error={fieldError(draw.error, 'month')}>
            {(p) => <Input {...p} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
          <ErrorAlert error={draw.error} />
          <Button variant="primary" loading={draw.isPending} disabled={!month} onClick={() => draw.mutate(undefined)}>
            {t('draw')}
          </Button>
        </div>
      </Card>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('noReport')}
            columns={[
              { key: 'm', header: t('month'), cell: (r) => f.month(r.month) },
              { key: 'v', header: t('col.version'), cell: (r) => (r.bySweep ? t('versionMonthly', { version: r.version }) : r.version) },
              { key: 'g', header: t('col.written'), cell: (r) => f.dateTime(r.generatedAt) },
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
