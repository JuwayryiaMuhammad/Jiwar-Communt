'use client';

import { QueryState } from '@jiwar/api/react';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubRequest } from '@/lib/queries';

type Status = '' | 'requested' | 'paid' | 'cancelled';

const STATUS: Record<string, { label: string; tone: 'terracotta' | 'green' | 'beige' }> = {
  requested: { label: 'Waiting for payment', tone: 'terracotta' },
  paid: { label: 'Paid', tone: 'green' },
  cancelled: { label: 'Called off', tone: 'beige' },
};

/**
 * Club membership requests (ADR 0070): residents ask for a plan, its price
 * is owed through the unit's invoices, and the membership starts or is
 * extended once paid. The club's staff follow them here; payments are taken
 * in finance, against the request's invoice.
 */
export default function ClubRequestsPage() {
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
        <PageHeader title="Club requests" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Club requests"
        description="Plans residents asked for. Each owes its price through the unit's invoice; once paid, the membership starts or is extended on its own."
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'requested', label: 'Waiting for payment' },
            { value: 'paid', label: 'Paid' },
            { value: 'cancelled', label: 'Called off' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <QueryState query={requests}>
        {requests.data ? (
          <Card flush>
            <DataTable<ClubRequest>
              rows={requests.data.data}
              rowKey={(r) => r.id}
              empty="No request here."
              columns={[
                { key: 'unit', header: 'Unit', cell: (r) => r.unitCode },
                { key: 'amount', header: 'Price', cell: (r) => egp(r.amount) },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (r) => <Badge tone={STATUS[r.status]?.tone ?? 'beige'}>{STATUS[r.status]?.label ?? r.status}</Badge>,
                },
                { key: 'asked', header: 'Asked', cell: (r) => new Date(r.createdAt).toLocaleDateString() },
                { key: 'paid', header: 'Paid', cell: (r) => (r.paidAt ? new Date(r.paidAt).toLocaleDateString() : '—') },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
