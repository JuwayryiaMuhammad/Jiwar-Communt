'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type WarrantyClaim } from '@/lib/queries';

const STATUSES = ['open', 'accepted', 'rejected', 'withdrawn'] as const;

/** Every claim under an asset's warranty (ADR 0076); each is decided on its asset's page. */
export default function WarrantyClaimsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('assets.manage');
  const [status, setStatus] = useState<WarrantyClaim['status'] | ''>('open');
  const list = useCursorList(keys.warrantyClaims({ status }), (c) => fetchers.warrantyClaims({ status }, c), {
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Warranty claims" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Warranty claims" description="Claims made under the assets’ warranties. Each is decided on its asset’s page." />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WarrantyClaim['status'] | '')}>
              <option value="">Any status</option>
              {STATUSES.map((x) => (
                <option key={x} value={x}>
                  {humanize(x)}
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
            empty="No claim matches"
            columns={[
              { key: 'opened', header: 'Opened', width: 170, cell: (c) => formatDateTime(c.openedAt) },
              {
                key: 'asset',
                header: 'Asset',
                cell: (c) => (
                  <Link className="table__link" href={`/assets/${c.assetId}`}>
                    Open asset
                  </Link>
                ),
              },
              { key: 'what', header: 'What failed', cell: (c) => c.description },
              { key: 'ref', header: 'Reference', cell: (c) => c.reference ?? '—' },
              { key: 'status', header: 'Status', cell: (c) => <Badge>{humanize(c.status)}</Badge> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
