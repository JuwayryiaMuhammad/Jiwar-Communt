'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import Link from 'next/link';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaterialEntry } from '@/lib/queries';
import ar from '@/messages/ar/places-permits';
import en from '@/messages/en/places-permits';

/** Materials brought in, as the guards logged them (ADR 0049). */
export default function MaterialsLogPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const list = useCursorList(keys.materialEntries, (c) => fetchers.materialEntries(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('materials.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('materials.title')} description={t('materials.description')} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<MaterialEntry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={t('materials.empty')}
            columns={[
              { key: 't', header: t('col.when'), cell: (e) => fmt.dateTime(e.occurredAt) },
              { key: 'u', header: t('col.unit'), cell: (e) => <span className="t-mono">{e.unitCode}</span> },
              {
                key: 'p',
                header: t('col.permit'),
                cell: (e) =>
                  e.permitId ? (
                    <Link className="t-mono" href={`/permits/${e.permitId}`}>
                      {e.permitReference}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'd', header: t('col.whatCame'), cell: (e) => e.description },
              { key: 'g', header: t('col.guard'), cell: (e) => e.guard?.firstName ?? '—' },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
