'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useNameOf } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartRequest } from '@/lib/queries';
import ar from '@/messages/ar/stock-part-requests';
import en from '@/messages/en/stock-part-requests';

type Status = PartRequest['status'] | '';

/** The technicians' part requests (ADR 0065): reserved in a store, issued, or declined. */
export default function PartRequestsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const nameOf = useNameOf();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('');
  const [reserving, setReserving] = useState<PartRequest | null>(null);
  const [declining, setDeclining] = useState<PartRequest | null>(null);
  const [storeId, setStoreId] = useState('');
  const filters = { status };
  const list = useCursorList(keys.partRequests(filters), (c) => fetchers.partRequests(filters, c), { enabled: can('stock.manage') });
  const stores = useQuery({ queryKey: keys.stores, queryFn: fetchers.stores, enabled: can('stock.manage') });
  const reserve = useAction(
    () =>
      unwrap(api.POST('/api/v1/maintenance/part-requests/{id}/reserve', { params: { path: { id: reserving!.id } }, body: { storeId } })),
    {
      invalidate: [keys.stockAll],
      onDone: () => {
        toast.show(t('reserved'));
        setReserving(null);
      },
    },
  );
  const issue = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/part-requests/{id}/issue', { params: { path: { id } } })),
    { invalidate: [keys.stockAll], onDone: () => toast.show(t('issued')) },
  );
  const decline = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/part-requests/{id}/decline', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.stockAll],
      onDone: () => {
        toast.show(t('declined'));
        setDeclining(null);
      },
    },
  );
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Status>
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('status.open') },
            { value: 'reserved', label: t('status.reserved') },
            { value: 'issued', label: t('status.issued') },
            { value: 'declined', label: t('status.declined') },
            { value: 'cancelled', label: t('status.cancelled') },
          ]}
        />
      </div>
      <ErrorAlert error={issue.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 't',
                header: t('col.ticket'),
                cell: (r) => (
                  <Link className="table__link" href={`/maintenance/${r.ticketId}`}>
                    {t('open')}
                  </Link>
                ),
              },
              {
                key: 'i',
                header: t('col.item'),
                cell: (r) => (
                  <Link className="table__link" href={`/stock/${r.itemId}`}>
                    {t('item')}
                  </Link>
                ),
              },
              { key: 'q', header: t('col.quantity'), cell: (r) => r.quantity },
              { key: 's', header: t('col.status'), cell: (r) => label(r.status) },
              { key: 'w', header: t('col.asked'), cell: (r) => f.dateTime(r.requestedAt) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'requested' || r.status === 'reserved' ? (
                    <span className="row" style={{ gap: 6 }}>
                      {r.status === 'requested' ? (
                        <Button size="sm" variant="primary" onClick={() => setReserving(r)}>
                          {t('reserve')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" loading={issue.isPending} onClick={() => issue.mutate(r.id)}>
                          {t('issue')}
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setDeclining(r)}>
                        {t('decline')}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <Dialog
        open={reserving !== null}
        onClose={() => setReserving(null)}
        title={t('reserveTitle')}
        description={t('reserveDescription')}
        onSubmit={() => storeId && reserve.mutate()}
        footer={
          <>
            <Button onClick={() => setReserving(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={reserve.isPending} disabled={!storeId}>
              {t('reserve')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={reserve.error} />
          <Field label={t('store')}>
            {(p) => (
              <Select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">{c('select')}</option>
                {(stores.data?.data ?? [])
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {nameOf(s)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title={t('declineTitle')}
        codes={REASON_CODES.partRequestDecline}
        confirmLabel={t('decline')}
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(code) => declining && decline.mutate({ id: declining.id, reasonCode: code })}
      />
    </>
  );
}
