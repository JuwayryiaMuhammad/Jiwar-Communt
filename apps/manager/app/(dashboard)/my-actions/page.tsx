'use client';

import { formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetchers, keys, type OwnIncidentAction } from '@/lib/queries';

/**
 * My corrective actions (ADR 0087): any staff member or the manager given
 * one, with no permission; marked done here.
 */
export default function MyActionsPage() {
  const toast = useToast();
  const mine = useQuery({ queryKey: keys.myIncidentActions, queryFn: fetchers.myIncidentActions });
  const done = useAction(
    (actionId: string) =>
      unwrap(api.POST('/api/v1/staff/incident-actions/{actionId}/done', { params: { path: { actionId } }, body: {} })),
    { invalidate: [keys.myIncidentActions], onDone: () => toast.show('Marked done.') },
  );
  return (
    <>
      <PageHeader title="My corrective actions" description="What an incident’s investigation asked of you, by its day." />
      <ErrorAlert error={done.error} />
      <Card flush>
        <QueryState query={mine}>
          <DataTable<OwnIncidentAction>
            rows={mine.data?.data ?? []}
            rowKey={(a) => a.id}
            empty="Nothing asked of you"
            columns={[
              { key: 'i', header: 'Incident', cell: (a) => `${a.incident.reference} · ${humanize(a.incident.type)}` },
              { key: 'd', header: 'Action', cell: (a) => a.description ?? '—' },
              { key: 'due', header: 'Due', cell: (a) => `${formatDate(a.dueOn)}${a.overdue ? ' · overdue' : ''}` },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (a) => (
                  <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a.id)}>
                    Done
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
