'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ImportDialog, NewAssetDialog } from '@/components/assets/asset-dialogs';
import { CONDITION_TONE, nameOf } from '@/components/assets/format';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetFilters, type AssetSummary } from '@/lib/queries';
import ar from '@/messages/ar/assets-register';
import en from '@/messages/en/assets-register';

const VIEWS = ['in_service', 'out_of_service', 'retired', 'all'] as const;

/** The compound's asset register (ADR 0064). */
export default function AssetsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<AssetFilters['status']>('in_service');
  const [open, setOpen] = useState<'new' | 'import' | null>(null);
  const filters: AssetFilters = { status };
  const list = useCursorList(keys.assets(filters), (c) => fetchers.assets(filters, c), { enabled: can('assets.read') });
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes, enabled: can('assets.read') });
  const typeName = new Map((types.data?.data ?? []).map((x) => [x.id, nameOf(fmt.locale, x)]));
  if (ready && !can('assets.read'))
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
          can('assets.manage') ? (
            <span className="row" style={{ gap: 8 }}>
              <Button icon={<Upload aria-hidden />} onClick={() => setOpen('import')}>
                {t('import')}
              </Button>
              <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
                {t('newAsset')}
              </Button>
            </span>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<NonNullable<AssetFilters['status']>>
          label={t('status')}
          value={status ?? ''}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v === 'all' ? '' : v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AssetSummary>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'code',
                header: t('col.code'),
                cell: (a) => (
                  <Link className="table__link t-mono" href={`/assets/${a.id}`}>
                    {a.code}
                  </Link>
                ),
              },
              { key: 'name', header: t('col.name'), cell: (a) => <span className="table__primary">{nameOf(fmt.locale, a)}</span> },
              { key: 'type', header: t('col.type'), cell: (a) => typeName.get(a.typeId) ?? '—' },
              { key: 'part', header: t('col.level'), cell: (a) => (a.depth > 1 ? t('part', { depth: a.depth }) : t('root')) },
              { key: 'condition', header: t('col.condition'), cell: (a) => <Badge tone={CONDITION_TONE[a.condition]}>{label(a.condition)}</Badge> },
              { key: 'criticality', header: t('col.criticality'), cell: (a) => label(a.criticality) },
              { key: 'warranty', header: t('col.warranty'), cell: (a) => (a.warrantyEndsOn ? fmt.day(a.warrantyEndsOn) : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open === 'new' ? <NewAssetDialog onClose={() => setOpen(null)} /> : null}
      {open === 'import' ? <ImportDialog onClose={() => setOpen(null)} /> : null}
    </>
  );
}
