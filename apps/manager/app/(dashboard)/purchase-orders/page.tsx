'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, ButtonLink, Card, DataTable, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useVendorChoices } from '@/components/purchase-orders/pickers';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseOrder, type PurchaseOrderStatus } from '@/lib/queries';
import ar from '@/messages/ar/po-list';
import commonAr from '@/messages/ar/po-common';
import en from '@/messages/en/po-list';
import commonEn from '@/messages/en/po-common';

type View = 'waiting' | 'all';
const STATUSES: PurchaseOrderStatus[] = ['requested', 'approved', 'rejected', 'cancelled', 'closed'];
/** Who the API lets list orders. */
const READERS = ['purchase_orders.raise', 'purchase_orders.receive', 'purchases.approve', 'finance.payables', 'finance.payables_approve'];

function Orders() {
  const t = useT(en, ar);
  const w = useT(commonEn, commonAr);
  const f = useFormat();
  const search = useSearchParams();
  const { ready, can } = usePermissions();
  const allowed = READERS.some((p) => can(p));
  const [view, setView] = useState<View>(search.get('view') === 'waiting' ? 'waiting' : 'all');
  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('');
  const [vendorId, setVendorId] = useState('');
  const { allowed: readsVendors, vendors } = useVendorChoices();
  const filters = view === 'waiting' ? { waiting: true, vendorId } : { status, vendorId };
  const list = useCursorList(keys.purchaseOrders(filters), (cursor) => fetchers.purchaseOrders(filters, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 12 }}>
            {can('finance.payables') || can('finance.payables_approve') ? <Link href="/purchase-orders/settings">{t('settingsLink')}</Link> : null}
            {can('purchase_orders.raise') ? (
              <ButtonLink href="/purchase-orders/new" variant="primary">
                {t('raise')}
              </ButtonLink>
            ) : null}
          </span>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('view')}
          value={view}
          onChange={setView}
          options={[
            { value: 'waiting', label: t('view.waiting') },
            { value: 'all', label: t('view.all') },
          ]}
        />
        {view === 'all' ? (
          <Select aria-label={t('status')} value={status} onChange={(e) => setStatus(e.target.value as PurchaseOrderStatus | '')}>
            <option value="">{t('anyStatus')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {w(`status.${s}`)}
              </option>
            ))}
          </Select>
        ) : null}
        {readsVendors ? (
          <Select aria-label={t('vendor')} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">{t('anyVendor')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {`${v.reference} · ${v.name}`}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PurchaseOrder>
            rows={list.rows}
            rowKey={(o) => o.id}
            empty={view === 'waiting' ? t('emptyWaiting') : t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.order'),
                cell: (o) => (
                  <Link className="ltr" href={`/purchase-orders/${o.id}`}>
                    {o.reference}
                  </Link>
                ),
              },
              { key: 'v', header: t('col.vendor'), cell: (o) => o.vendorName },
              { key: 't', header: t('col.total'), cell: (o) => f.money(o.total) },
              {
                key: 's',
                header: t('col.status'),
                cell: (o) => (
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <StatusBadge status={o.status} label={w(`status.${o.status}`)} />
                    {o.pendingRevision !== null ? <Badge tone="terracotta">{w('revisionWaiting', { n: f.number(o.pendingRevision) })}</Badge> : null}
                  </span>
                ),
              },
              { key: 'd', header: t('col.delivery'), cell: (o) => f.day(o.deliveryOn) },
              { key: 'a', header: t('col.raised'), cell: (o) => f.date(o.raisedAt) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}

/** Purchase orders (ADR 0094): what the compound orders from its vendors, the ones waiting for a decision first when asked. */
export default function PurchaseOrdersPage() {
  return (
    <Suspense>
      <Orders />
    </Suspense>
  );
}
