'use client';

import { formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseRequest } from '@/lib/queries';

type Status = PurchaseRequest['status'] | '';

function Decide({ r }: { r: PurchaseRequest }) {
  const toast = useToast();
  const path = { params: { path: { id: r.id } } };
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/approve', { ...path, body: {} })), {
    invalidate: [keys.purchasesAll],
    onDone: () => toast.show(`${r.reference} is approved.`),
  });
  const reject = useAction(
    () => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/reject', { ...path, body: { reasonCode: 'not_needed' } })),
    { invalidate: [keys.purchasesAll], onDone: () => toast.show(`${r.reference} is turned down.`) },
  );
  const fulfil = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/fulfil', { ...path, body: {} })), {
    invalidate: [keys.purchasesAll],
    onDone: () => toast.show(`${r.reference} is marked bought.`),
  });
  return (
    <>
      <ErrorAlert error={approve.error ?? reject.error ?? fulfil.error} />
      {r.status === 'requested' ? (
        <>
          <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </Button>{' '}
          <Button size="sm" loading={reject.isPending} onClick={() => reject.mutate()}>
            Turn down
          </Button>
        </>
      ) : r.status === 'approved' ? (
        <Button size="sm" loading={fulfil.isPending} onClick={() => fulfil.mutate()}>
          Mark bought
        </Button>
      ) : null}
    </>
  );
}

/** Purchase requests (ADR 0077): what the staff ask to buy, decided by the manager up to the limit. */
export default function PurchasesPage() {
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('requested');
  const filters = { status };
  const allowed = can('purchases.approve') || can('purchases.request');
  const list = useCursorList(keys.purchases(filters), (c) => fetchers.purchases(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Purchase requests" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Purchase requests"
        description="What the staff ask to buy. Above the manager’s limit, the board’s approved major contract covers it."
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'requested', label: 'Waiting' },
            { value: 'approved', label: 'Approved' },
            { value: 'fulfilled', label: 'Bought' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PurchaseRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No purchase request"
            columns={[
              { key: 'r', header: 'Request', cell: (r) => `${r.reference} · ${r.title}` },
              { key: 'a', header: 'Amount', cell: (r) => `${r.estimatedAmount} EGP` },
              { key: 'n', header: 'Needed by', cell: (r) => (r.neededBy ? formatDate(r.neededBy) : '—') },
              { key: 's', header: 'Status', cell: (r) => humanize(r.status) },
              { key: 'd', header: '', cell: (r) => (can('purchases.approve') ? <Decide r={r} /> : null) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
