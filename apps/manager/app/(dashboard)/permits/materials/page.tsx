'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import Link from 'next/link';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaterialEntry } from '@/lib/queries';

/** Materials brought in, as the guards logged them (ADR 0049). */
export default function MaterialsLogPage() {
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const list = useCursorList(keys.materialEntries, (c) => fetchers.materialEntries(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Materials log" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Materials log"
        description="Bringing materials in needs no permit: the guard logs what came. Taking them out needs a material exit approved in advance."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<MaterialEntry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty="Nothing logged"
            columns={[
              { key: 't', header: 'When', cell: (e) => formatDateTime(e.occurredAt) },
              { key: 'u', header: 'Unit', cell: (e) => <span className="t-mono">{e.unitCode}</span> },
              {
                key: 'p',
                header: 'Permit',
                cell: (e) =>
                  e.permitId ? (
                    <Link className="t-mono" href={`/permits/${e.permitId}`}>
                      {e.permitReference}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'd', header: 'What came', cell: (e) => e.description },
              { key: 'g', header: 'Guard', cell: (e) => e.guard?.firstName ?? '—' },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
