'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, PageHeader, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetchers, keys, type OwnIncidentAction } from '@/lib/queries';
import ar from '@/messages/ar/notifications-page';
import en from '@/messages/en/notifications-page';

/**
 * My corrective actions (ADR 0087): any staff member or the manager given
 * one, with no permission; marked done here.
 */
export default function MyActionsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const mine = useQuery({ queryKey: keys.myIncidentActions, queryFn: fetchers.myIncidentActions });
  const done = useAction(
    (actionId: string) =>
      unwrap(api.POST('/api/v1/staff/incident-actions/{actionId}/done', { params: { path: { actionId } }, body: {} })),
    { invalidate: [keys.myIncidentActions], onDone: () => toast.show(t('markedDone')) },
  );
  return (
    <>
      <PageHeader title={t('actionsTitle')} description={t('actionsDescription')} />
      <ErrorAlert error={done.error} />
      <Card flush>
        <QueryState query={mine}>
          <DataTable<OwnIncidentAction>
            rows={mine.data?.data ?? []}
            rowKey={(a) => a.id}
            empty={t('actionsEmpty')}
            columns={[
              { key: 'i', header: t('incident'), cell: (a) => `${a.incident.reference} · ${label(a.incident.type)}` },
              { key: 'd', header: t('action'), cell: (a) => a.description ?? '—' },
              {
                key: 'due',
                header: t('due'),
                cell: (a) => (a.overdue ? t('dueOverdue', { date: f.day(a.dueOn) }) : f.day(a.dueOn)),
              },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (a) => (
                  <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a.id)}>
                    {t('done')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
