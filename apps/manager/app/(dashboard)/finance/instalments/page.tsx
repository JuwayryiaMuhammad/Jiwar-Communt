'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InstalmentPlan, type InstalmentPlanFilters } from '@/lib/queries';

type View = 'active' | 'settled' | 'cancelled' | 'all';

/**
 * Instalment plans (ADR 0048): an invoice's outstanding split into
 * instalment invoices. Split one from its invoice; cancel one here.
 */
export default function InstalmentPlansPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const [view, setView] = useState<View>('active');
  const filters: InstalmentPlanFilters = { status: view === 'all' ? '' : view };
  const list = useCursorList(keys.instalmentPlans(filters), (c) => fetchers.instalmentPlans(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Instalment plans" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Instalment plans"
        description="Invoices split into instalments. To split one, open the invoice and choose “Split into instalments”."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Plans shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'settled', label: 'Settled' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<InstalmentPlan>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No plan"
            columns={[
              {
                key: 'n',
                header: 'Plan',
                cell: (p) => (
                  <Link className="t-mono" href={`/finance/instalments/${p.id}`}>
                    {p.number}
                  </Link>
                ),
              },
              {
                key: 'u',
                header: 'Unit',
                cell: (p) => (
                  <Link className="t-mono" href={`/finance/units/${p.unitId}`}>
                    {p.unitCode}
                  </Link>
                ),
              },
              { key: 'i', header: 'Invoice', cell: (p) => <span className="t-mono">{p.invoiceNumber}</span> },
              { key: 'c', header: 'Instalments', cell: (p) => p.instalmentCount },
              { key: 't', header: 'Total', cell: (p) => egp(p.total) },
              { key: 'o', header: 'Owed', cell: (p) => egp(p.outstanding) },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'w', header: 'Set up', cell: (p) => <span title={formatDateTime(p.createdAt)}>{relativeTime(p.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
