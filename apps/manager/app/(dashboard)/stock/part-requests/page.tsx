'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartRequest } from '@/lib/queries';

type Status = PartRequest['status'] | '';

/** The technicians' part requests (ADR 0065): reserved in a store, issued, or declined. */
export default function PartRequestsPage() {
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
        toast.show('Reserved; the technician is told.');
        setReserving(null);
      },
    },
  );
  const issue = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/part-requests/{id}/issue', { params: { path: { id } } })),
    { invalidate: [keys.stockAll], onDone: () => toast.show('Issued onto the ticket’s costs.') },
  );
  const decline = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/part-requests/{id}/decline', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.stockAll],
      onDone: () => {
        toast.show('Declined.');
        setDeclining(null);
      },
    },
  );
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title="Part requests" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Part requests" description="What the technicians ask the store for, oldest first." />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'Open' },
            { value: 'reserved', label: 'Reserved' },
            { value: 'issued', label: 'Issued' },
            { value: 'declined', label: 'Declined' },
            { value: 'cancelled', label: 'Called off' },
          ]}
        />
      </div>
      <ErrorAlert error={issue.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="Nothing asked for"
            columns={[
              {
                key: 't',
                header: 'Ticket',
                cell: (r) => (
                  <Link className="table__link" href={`/maintenance/${r.ticketId}`}>
                    Open
                  </Link>
                ),
              },
              {
                key: 'i',
                header: 'Item',
                cell: (r) => (
                  <Link className="table__link" href={`/stock/${r.itemId}`}>
                    Item
                  </Link>
                ),
              },
              { key: 'q', header: 'Quantity', cell: (r) => r.quantity },
              { key: 's', header: 'Status', cell: (r) => humanize(r.status) },
              { key: 'w', header: 'Asked', cell: (r) => formatDateTime(r.requestedAt) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'requested' || r.status === 'reserved' ? (
                    <span className="row" style={{ gap: 6 }}>
                      {r.status === 'requested' ? (
                        <Button size="sm" variant="primary" onClick={() => setReserving(r)}>
                          Reserve
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" loading={issue.isPending} onClick={() => issue.mutate(r.id)}>
                          Issue
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setDeclining(r)}>
                        Decline
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
        title="Reserve the part"
        description="It is held in the store for the ticket until it is issued or let go."
        onSubmit={() => storeId && reserve.mutate()}
        footer={
          <>
            <Button onClick={() => setReserving(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={reserve.isPending} disabled={!storeId}>
              Reserve
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={reserve.error} />
          <Field label="Store">
            {(p) => (
              <Select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">Select…</option>
                {(stores.data?.data ?? [])
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {s.nameEn}
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
        title="Decline the request"
        codes={REASON_CODES.partRequestDecline}
        confirmLabel="Decline"
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(c) => declining && decline.mutate({ id: declining.id, reasonCode: c })}
      />
    </>
  );
}
