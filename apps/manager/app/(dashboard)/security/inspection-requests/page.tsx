'use client';

import { errorText, formatDate, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { api } from '@/lib/api';

type Request = Schema<'StaffInspectionRequestView'>;
const VIEWS = ['open', 'scheduled', 'done', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['inspection-requests'] as const;

/**
 * A closed unit's owners, or its proxy, ask for a guard's visit (ADR 0063).
 * Schedule one as a closed-unit inspection task: the guard's completion
 * closes the request and the owner reads the report in the app.
 */
export default function InspectionRequestsPage() {
  const toast = useToast();
  const [view, setView] = useState<View>('open');
  const [scheduling, setScheduling] = useState<Request | null>(null);
  const [cancelling, setCancelling] = useState<Request | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () =>
      unwrap(api.GET('/api/v1/staff/security/inspection-requests', { params: { query: { status: view } } })),
    refetchInterval: 120_000,
  });
  const cancel = useAction(
    (v: { r: Request; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/security/inspection-requests/{id}/cancel', {
          params: { path: { id: v.r.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Cancelled.');
        setCancelling(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title="Inspection requests"
        description="Closed units their owners ask the guards to visit. Schedule one as an inspection task."
      />
      <Segmented<View>
        label="Show"
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Request>
            rows={list.data}
            rowKey={(r) => r.id}
            empty="No request here"
            emptyHint="An owner asks from the app while the unit is closed."
            columns={[
              { key: 'unit', header: 'Unit', cell: (r) => <strong>{r.unitCode}</strong> },
              { key: 'day', header: 'Preferred day', cell: (r) => formatDate(r.preferredOn) },
              { key: 'asked', header: 'Asked', cell: (r) => formatDateTime(r.createdAt) },
              {
                key: 'act',
                header: '',
                cell: (r) =>
                  r.status === 'open' ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="primary" onClick={() => setScheduling(r)}>
                        Schedule
                      </Button>
                      <Button size="sm" onClick={() => setCancelling(r)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="t-secondary">{r.status}</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {scheduling ? (
        <NewTaskDialog
          request={{ id: scheduling.id, unitId: scheduling.unitId, unitCode: scheduling.unitCode }}
          onClose={() => setScheduling(null)}
        />
      ) : null}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel the request"
        description="The owner sees the reason. A scheduled one is cancelled with its task."
        codes={REASON_CODES.inspectionRequestCancel}
        confirmLabel="Cancel the request"
        danger
        pending={cancel.isPending}
        error={cancel.error ? errorText(cancel.error) : undefined}
        onConfirm={(reasonCode) => cancelling && cancel.mutate({ r: cancelling, reasonCode })}
      />
    </>
  );
}
