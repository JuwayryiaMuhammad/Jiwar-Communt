'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PERMIT_KIND_TEXT, periodText } from '@/components/permits/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PermitFilters, type PermitKind, type StaffPermit } from '@/lib/queries';

type View = 'pending' | 'live' | 'all';
type Kind = PermitKind | 'any';

/** The units' permits (ADR 0049): the queue to decide, and what is in force now. */
export default function PermitsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const [view, setView] = useState<View>('pending');
  const [kind, setKind] = useState<Kind>('any');
  const filters: PermitFilters = {
    status: view === 'pending' ? 'pending' : '',
    kind: kind === 'any' ? '' : kind,
    live: view === 'live',
  };
  const list = useCursorList(keys.permits(filters), (c) => fetchers.permits(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Permits" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Permits"
        description="Works by a contractor, furniture moves, materials going out and private events. Events of 20 guests or fewer are approved at once; the rest wait here."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Permits shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'pending', label: 'To decide' },
            { value: 'live', label: 'In force now' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Segmented<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'any', label: 'Any kind' },
            { value: 'works', label: PERMIT_KIND_TEXT.works },
            { value: 'move', label: PERMIT_KIND_TEXT.move },
            { value: 'material_exit', label: PERMIT_KIND_TEXT.material_exit },
            { value: 'event', label: PERMIT_KIND_TEXT.event },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffPermit>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={view === 'pending' ? 'Nothing to decide' : 'No permit'}
            columns={[
              {
                key: 'r',
                header: 'Permit',
                cell: (p) => (
                  <Link className="table__link t-mono" href={`/permits/${p.id}`}>
                    {p.reference}
                  </Link>
                ),
              },
              { key: 'k', header: 'Kind', cell: (p) => PERMIT_KIND_TEXT[p.kind] },
              { key: 'u', header: 'Unit', cell: (p) => <span className="t-mono">{p.unitCode}</span> },
              { key: 'w', header: 'When', cell: (p) => periodText(p, formatDateTime) },
              { key: 'b', header: 'Asked by', cell: (p) => p.requestedBy.fullName ?? '—' },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'c', header: 'Asked', cell: (p) => <span title={formatDateTime(p.createdAt)}>{relativeTime(p.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
