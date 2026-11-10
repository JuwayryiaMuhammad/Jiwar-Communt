'use client';

import { ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, PageHeader, ReasonCodeDialog, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { api } from '@/lib/api';
import ar from '@/messages/ar/sec-inspection-requests';
import en from '@/messages/en/sec-inspection-requests';

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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(t('cancelled'));
        setCancelling(null);
      },
    },
  );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Segmented<View> label={t('show')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: label(v) }))} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Request>
            rows={list.data}
            rowKey={(r) => r.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              { key: 'unit', header: t('col.unit'), cell: (r) => <strong>{r.unitCode}</strong> },
              { key: 'day', header: t('col.day'), cell: (r) => f.day(r.preferredOn) },
              { key: 'asked', header: t('col.asked'), cell: (r) => f.dateTime(r.createdAt) },
              {
                key: 'act',
                header: '',
                cell: (r) =>
                  r.status === 'open' ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="primary" onClick={() => setScheduling(r)}>
                        {t('schedule')}
                      </Button>
                      <Button size="sm" onClick={() => setCancelling(r)}>
                        {c('cancel')}
                      </Button>
                    </span>
                  ) : (
                    <span className="t-secondary">{label(r.status)}</span>
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
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        codes={REASON_CODES.inspectionRequestCancel}
        confirmLabel={t('cancelTitle')}
        danger
        pending={cancel.isPending}
        error={cancel.error ? <ErrorText error={cancel.error} /> : undefined}
        onConfirm={(reasonCode) => cancelling && cancel.mutate({ r: cancelling, reasonCode })}
      />
    </>
  );
}
