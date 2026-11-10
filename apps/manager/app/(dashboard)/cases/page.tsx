'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select, useCommonT, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceCase } from '@/lib/queries';
import ar from '@/messages/ar/cases';
import en from '@/messages/en/cases';

/**
 * Community cases (ADR 0081): one problem many households of a building
 * report, opened by itself at the compound’s threshold.
 */
export default function CasesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [status, setStatus] = useState<MaintenanceCase['status'] | ''>('open');
  const list = useCursorList(keys.cases(status), (c) => fetchers.cases(status, c), { enabled: allowed });
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
        <Field label={c('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as MaintenanceCase['status'] | '')}>
              <option value="">{t('anyStatus')}</option>
              {(['open', 'resolved', 'dismissed'] as const).map((x) => (
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
          <DataTable<MaintenanceCase>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={t('empty')}
            columns={[
              {
                key: 'opened',
                header: t('opened'),
                width: 170,
                cell: (c) => (
                  <Link className="table__link" href={`/cases/${c.id}`}>
                    {f.dateTime(c.openedAt)}
                  </Link>
                ),
              },
              { key: 'building', header: c('building'), cell: (c) => c.buildingName ?? '—' },
              { key: 'category', header: t('category'), cell: (x) => label(x.categoryKey) },
              { key: 'tickets', header: t('tickets'), cell: (x) => f.number(x.ticketCount) },
              { key: 'order', header: t('workOrder'), cell: (c) => c.workOrder?.number ?? '—' },
              { key: 'status', header: c('status'), cell: (x) => <Badge>{label(x.status)}</Badge> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
