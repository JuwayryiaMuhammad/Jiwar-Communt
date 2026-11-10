'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type WarrantyClaim } from '@/lib/queries';
import ar from '@/messages/ar/warranty-claims';
import en from '@/messages/en/warranty-claims';

const STATUSES = ['open', 'accepted', 'rejected', 'withdrawn'] as const;

/** Every claim under an asset's warranty (ADR 0076); each is decided on its asset's page. */
export default function WarrantyClaimsPage() {
  const t = useT(en, ar);
  const label = useLabel();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('assets.manage');
  const [status, setStatus] = useState<WarrantyClaim['status'] | ''>('open');
  const list = useCursorList(keys.warrantyClaims({ status }), (c) => fetchers.warrantyClaims({ status }, c), {
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
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WarrantyClaim['status'] | '')}>
              <option value="">{t('anyStatus')}</option>
              {STATUSES.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<WarrantyClaim>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={t('empty')}
            columns={[
              { key: 'opened', header: t('col.opened'), width: 170, cell: (c) => f.dateTime(c.openedAt) },
              {
                key: 'asset',
                header: t('col.asset'),
                cell: (c) => (
                  <Link className="table__link" href={`/assets/${c.assetId}`}>
                    {t('openAsset')}
                  </Link>
                ),
              },
              { key: 'what', header: t('col.what'), cell: (c) => c.description },
              { key: 'ref', header: t('col.reference'), cell: (c) => c.reference ?? '—' },
              { key: 'status', header: t('col.status'), cell: (c) => <Badge>{label(c.status)}</Badge> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
