'use client';

import { formatDateTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CATEGORY_TEXT, ratingText } from '@/components/partners/logic';
import { NewPartnerDialog } from '@/components/partners/new-partner-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffPartner } from '@/lib/queries';

/** The compound's service partners (ADR 0060). */
export default function PartnersPage() {
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const partners = useQuery({ queryKey: keys.partners, queryFn: fetchers.partners, enabled: allowed });
  const [adding, setAdding] = useState(false);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Partners" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Partners"
        description="The service partners residents find and ask: what they do, their prices and hours. Nothing is paid through Jiwar."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            New partner
          </Button>
        }
      />
      <Card flush>
        <QueryState query={partners}>
          <DataTable<StaffPartner>
            rows={partners.data?.data ?? []}
            rowKey={(p) => p.id}
            empty="No partner listed yet"
            columns={[
              {
                key: 'n',
                header: 'Partner',
                cell: (p) => (
                  <Link className="table__link" href={`/partners/${p.id}`}>
                    {p.nameEn}
                  </Link>
                ),
              },
              {
                key: 'c',
                header: 'Categories',
                cell: (p) => [...new Set(p.services.map((s) => CATEGORY_TEXT[s.category] ?? s.category))].join(', '),
              },
              { key: 'r', header: 'Rating', cell: (p) => ratingText(p.rating) },
              { key: 'd', header: 'Desk link', cell: (p) => (p.deskLink ? `Until ${formatDateTime(p.deskLink.expiresAt)}` : 'Relayed') },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'l', header: 'Listed', cell: (p) => formatDateTime(p.listedAt) },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <NewPartnerDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
