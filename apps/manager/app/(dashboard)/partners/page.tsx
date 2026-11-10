'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { localName } from '@/components/management-requests/logic';
import { ratingText, word } from '@/components/partners/logic';
import { NewPartnerDialog } from '@/components/partners/new-partner-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffPartner } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-list';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-list';

/** The compound's service partners (ADR 0060). */
export default function PartnersPage() {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const partners = useQuery({ queryKey: keys.partners, queryFn: fetchers.partners, enabled: allowed });
  const [adding, setAdding] = useState(false);
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
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            {t('newPartner')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={partners}>
          <DataTable<StaffPartner>
            rows={partners.data?.data ?? []}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 'n',
                header: t('col.partner'),
                cell: (p) => (
                  <Link className="table__link" href={`/partners/${p.id}`}>
                    {localName(locale, p)}
                  </Link>
                ),
              },
              {
                key: 'c',
                header: t('col.categories'),
                cell: (p) => f.list([...new Set(p.services.map((s) => word(codes, 'category', s.category)))]),
              },
              { key: 'r', header: t('col.rating'), cell: (p) => ratingText(codes, p.rating) },
              {
                key: 'd',
                header: t('col.desk'),
                cell: (p) => (p.deskLink ? t('deskUntil', { date: f.dateTime(p.deskLink.expiresAt) }) : t('deskRelayed')),
              },
              { key: 's', header: t('col.status'), cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'l', header: t('col.listed'), cell: (p) => f.dateTime(p.listedAt) },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <NewPartnerDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
