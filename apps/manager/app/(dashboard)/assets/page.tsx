'use client';

import { formatDate, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ImportDialog, NewAssetDialog } from '@/components/assets/asset-dialogs';
import { CONDITION_TONE } from '@/components/assets/format';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetFilters, type AssetSummary } from '@/lib/queries';

/** The compound's asset register (ADR 0064). */
export default function AssetsPage() {
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<AssetFilters['status']>('in_service');
  const [open, setOpen] = useState<'new' | 'import' | null>(null);
  const filters: AssetFilters = { status };
  const list = useCursorList(keys.assets(filters), (c) => fetchers.assets(filters, c), { enabled: can('assets.read') });
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes, enabled: can('assets.read') });
  const typeName = new Map((types.data?.data ?? []).map((t) => [t.id, t.nameEn]));
  if (ready && !can('assets.read'))
    return (
      <>
        <PageHeader title="Assets" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Assets"
        description="The compound's equipment: where it is, what it is, its warranty, its health and its history."
        actions={
          can('assets.manage') ? (
            <span className="row" style={{ gap: 8 }}>
              <Button icon={<Upload aria-hidden />} onClick={() => setOpen('import')}>
                Import
              </Button>
              <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
                New asset
              </Button>
            </span>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<NonNullable<AssetFilters['status']>>
          label="Status"
          value={status ?? ''}
          onChange={setStatus}
          options={[
            { value: 'in_service', label: 'In service' },
            { value: 'out_of_service', label: 'Out of service' },
            { value: 'retired', label: 'Retired' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AssetSummary>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="No asset"
            emptyHint="Add the compound's pumps, generators and lifts, or import them from a sheet."
            columns={[
              {
                key: 'code',
                header: 'Code',
                cell: (a) => (
                  <Link className="table__link t-mono" href={`/assets/${a.id}`}>
                    {a.code}
                  </Link>
                ),
              },
              { key: 'name', header: 'Name', cell: (a) => <span className="table__primary">{a.nameEn}</span> },
              { key: 'type', header: 'Type', cell: (a) => typeName.get(a.typeId) ?? '—' },
              { key: 'part', header: 'Level', cell: (a) => (a.depth > 1 ? `Part (level ${a.depth})` : 'Root') },
              { key: 'condition', header: 'Condition', cell: (a) => <Badge tone={CONDITION_TONE[a.condition]}>{humanize(a.condition)}</Badge> },
              { key: 'criticality', header: 'Criticality', cell: (a) => humanize(a.criticality) },
              { key: 'warranty', header: 'Warranty ends', cell: (a) => (a.warrantyEndsOn ? formatDate(a.warrantyEndsOn) : '—') },
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
