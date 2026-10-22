'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { requestTitle } from '@/components/partners/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerRequest, type PartnerRequestFilters } from '@/lib/queries';

type View = 'pending' | 'proposed' | 'accepted' | 'all';

/**
 * Requests to partners (ADR 0060), for the management's relay: a partner
 * without a desk link, or one who phones, has its requests answered here
 * as it would on its desk. What a partner sees, only while the resident's
 * consent holds.
 */
export default function PartnerRequestsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const [view, setView] = useState<View>('pending');
  const [partnerId, setPartnerId] = useState('');
  const partners = useQuery({ queryKey: keys.partners, queryFn: fetchers.partners, enabled: allowed });
  const filters: PartnerRequestFilters = { status: view === 'all' ? '' : view, partnerId };
  const list = useCursorList(keys.partnerRequests(filters), (c) => fetchers.partnerRequests(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Partner requests" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Partner requests"
        description="What residents asked the partners. Answer for a partner who phones or has no desk link."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Requests shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'pending', label: 'Waiting' },
            { value: 'proposed', label: 'Proposed' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Select aria-label="Partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">Every partner</option>
          {(partners.data?.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.nameEn}
            </option>
          ))}
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartnerRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No request"
            columns={[
              {
                key: 'n',
                header: 'Request',
                cell: (r) => (
                  <Link className="table__link" href={`/partners/requests/${r.id}`}>
                    {requestTitle(r)}
                  </Link>
                ),
              },
              { key: 'p', header: 'Partner', cell: (r) => r.partner.nameEn },
              { key: 'u', header: 'Unit', cell: (r) => (r.consentWithdrawn ? '—' : <span className="t-mono">{r.unitCode}</span>) },
              { key: 'w', header: 'Asked for', cell: (r) => formatDateTime(r.agreedStartsAt ?? r.askedStartsAt) },
              { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'c', header: 'Asked', cell: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
