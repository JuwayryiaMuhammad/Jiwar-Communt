'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InstalmentPlan, type InstalmentPlanFilters } from '@/lib/queries';
import ar from '@/messages/ar/fin-instalments';
import en from '@/messages/en/fin-instalments';

const VIEWS = ['active', 'settled', 'cancelled', 'all'] as const;
type View = (typeof VIEWS)[number];

/**
 * Instalment plans (ADR 0048): an invoice's outstanding split into
 * instalment invoices. Split one from its invoice; cancel one here.
 */
export default function InstalmentPlansPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const [view, setView] = useState<View>('active');
  const filters: InstalmentPlanFilters = { status: view === 'all' ? '' : view };
  const list = useCursorList(keys.instalmentPlans(filters), (cursor) => fetchers.instalmentPlans(filters, cursor), { enabled: allowed });
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
        <Segmented<View> label={t('shown')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))} />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<InstalmentPlan>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 'n',
                header: t('col.plan'),
                cell: (p) => (
                  <Link className="t-mono" href={`/finance/instalments/${p.id}`}>
                    {p.number}
                  </Link>
                ),
              },
              {
                key: 'u',
                header: c('unit'),
                cell: (p) => (
                  <Link className="t-mono" href={`/finance/units/${p.unitId}`}>
                    {p.unitCode}
                  </Link>
                ),
              },
              { key: 'i', header: t('col.invoice'), cell: (p) => <span className="t-mono">{p.invoiceNumber}</span> },
              { key: 'c', header: t('col.instalments'), cell: (p) => fmt.number(p.instalmentCount) },
              { key: 't', header: c('total'), cell: (p) => fmt.money(p.total) },
              { key: 'o', header: t('col.owed'), cell: (p) => fmt.money(p.outstanding) },
              { key: 's', header: c('status'), cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'w', header: t('col.setUp'), cell: (p) => <span title={fmt.dateTime(p.createdAt)}>{fmt.relative(p.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
