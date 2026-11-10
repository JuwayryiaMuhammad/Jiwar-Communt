'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { localName } from '@/components/management-requests/logic';
import { requestTitle } from '@/components/partners/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerRequest, type PartnerRequestFilters } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-requests';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-requests';

type View = 'pending' | 'proposed' | 'accepted' | 'all';

/**
 * Requests to partners (ADR 0060), for the management's relay: a partner
 * without a desk link, or one who phones, has its requests answered here
 * as it would on its desk. What a partner sees, only while the resident's
 * consent holds.
 */
export default function PartnerRequestsPage() {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={[
            { value: 'pending', label: t('view.pending') },
            { value: 'proposed', label: t('view.proposed') },
            { value: 'accepted', label: t('view.accepted') },
            { value: 'all', label: c('all') },
          ]}
        />
        <Select aria-label={t('partner')} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">{t('everyPartner')}</option>
          {(partners.data?.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {localName(locale, p)}
            </option>
          ))}
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartnerRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'n',
                header: t('col.request'),
                cell: (r) => (
                  <Link className="table__link" href={`/partners/requests/${r.id}`}>
                    {requestTitle(codes, r, locale)}
                  </Link>
                ),
              },
              { key: 'p', header: t('col.partner'), cell: (r) => localName(locale, r.partner) },
              { key: 'u', header: c('unit'), cell: (r) => (r.consentWithdrawn ? '—' : <span className="t-mono ltr">{r.unitCode}</span>) },
              { key: 'w', header: t('col.askedFor'), cell: (r) => f.dateTime(r.agreedStartsAt ?? r.askedStartsAt) },
              { key: 's', header: c('status'), cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'c', header: t('col.asked'), cell: (r) => <span title={f.dateTime(r.createdAt)}>{f.relative(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
