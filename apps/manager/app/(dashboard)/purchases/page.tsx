'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, DataTable, ForbiddenState, PageHeader, Segmented, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseRequest } from '@/lib/queries';
import ar from '@/messages/ar/ops-purchases';
import en from '@/messages/en/ops-purchases';

type Status = PurchaseRequest['status'] | '';
const VIEWS = ['requested', 'approved', 'fulfilled', ''] as const;

function Decide({ r }: { r: PurchaseRequest }) {
  const t = useT(en, ar);
  const toast = useToast();
  const path = { params: { path: { id: r.id } } };
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/approve', { ...path, body: {} })), {
    invalidate: [keys.purchasesAll],
    onDone: () => toast.show(t('approved', { reference: r.reference })),
  });
  const reject = useAction(
    () => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/reject', { ...path, body: { reasonCode: 'not_needed' } })),
    { invalidate: [keys.purchasesAll], onDone: () => toast.show(t('rejected', { reference: r.reference })) },
  );
  const fulfil = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-requests/{id}/fulfil', { ...path, body: {} })), {
    invalidate: [keys.purchasesAll],
    onDone: () => toast.show(t('fulfilled', { reference: r.reference })),
  });
  return (
    <>
      <ErrorAlert error={approve.error ?? reject.error ?? fulfil.error} />
      {r.status === 'requested' ? (
        <>
          <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
            {t('approve')}
          </Button>{' '}
          <Button size="sm" loading={reject.isPending} onClick={() => reject.mutate()}>
            {t('reject')}
          </Button>
        </>
      ) : r.status === 'approved' ? (
        <Button size="sm" loading={fulfil.isPending} onClick={() => fulfil.mutate()}>
          {t('fulfil')}
        </Button>
      ) : null}
    </>
  );
}

/** Purchase requests (ADR 0077): what the staff ask to buy, decided by the manager up to the limit. */
export default function PurchasesPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('requested');
  const filters = { status };
  const allowed = can('purchases.approve') || can('purchases.request');
  const list = useCursorList(keys.purchases(filters), (c) => fetchers.purchases(filters, c), { enabled: allowed });
  if (ready && !allowed)
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
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PurchaseRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.request'),
                cell: (r) => (
                  <>
                    <span className="t-mono">{r.reference}</span> · {r.title}
                  </>
                ),
              },
              { key: 'a', header: t('col.amount'), cell: (r) => fmt.money(r.estimatedAmount) },
              { key: 'n', header: t('col.neededBy'), cell: (r) => (r.neededBy ? fmt.day(r.neededBy) : '—') },
              { key: 's', header: t('col.status'), cell: (r) => label(r.status) },
              {
                key: 'd',
                header: '',
                cell: (r) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {can('purchases.approve') ? <Decide r={r} /> : null}
                    {r.status === 'approved' && can('purchase_orders.raise') ? (
                      <ButtonLink size="sm" href={`/purchase-orders/new?purchaseRequestId=${r.id}`}>
                        {t('raiseOrder')}
                      </ButtonLink>
                    ) : null}
                  </span>
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
