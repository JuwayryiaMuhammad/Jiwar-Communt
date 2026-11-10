'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Segmented, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubRequest } from '@/lib/queries';
import ar from '@/messages/ar/money-club-requests';
import en from '@/messages/en/money-club-requests';

type Status = '' | 'requested' | 'paid' | 'cancelled';

const TONE: Record<string, 'terracotta' | 'green' | 'beige'> = {
  requested: 'terracotta',
  paid: 'green',
  cancelled: 'beige',
};
const STATUSES = ['requested', 'paid', 'cancelled'] as const;
const isStatus = (s: string): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s);

/**
 * Club membership requests (ADR 0070): residents ask for a plan, its price
 * is owed through the unit's invoices, and the membership starts or is
 * extended once paid. The club's staff follow them here; payments are taken
 * in finance, against the request's invoice.
 */
export default function ClubRequestsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('club.billing');
  const [status, setStatus] = useState<Status>('requested');
  const requests = useQuery({
    queryKey: keys.clubRequests(status),
    queryFn: () => fetchers.clubRequests(status),
    enabled: allowed,
  });
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
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={[...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })), { value: '' as const, label: c('all') }]}
        />
      </div>
      <QueryState query={requests}>
        {requests.data ? (
          <Card flush>
            <DataTable<ClubRequest>
              rows={requests.data.data}
              rowKey={(r) => r.id}
              empty={t('empty')}
              columns={[
                { key: 'unit', header: t('col.unit'), cell: (r) => r.unitCode },
                { key: 'amount', header: t('col.price'), cell: (r) => fmt.money(r.amount) },
                {
                  key: 'status',
                  header: t('col.status'),
                  cell: (r) => <Badge tone={TONE[r.status] ?? 'beige'}>{isStatus(r.status) ? t(`status.${r.status}`) : r.status}</Badge>,
                },
                { key: 'asked', header: t('col.asked'), cell: (r) => fmt.date(r.createdAt) },
                { key: 'paid', header: t('col.paid'), cell: (r) => (r.paidAt ? fmt.date(r.paidAt) : '—') },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
