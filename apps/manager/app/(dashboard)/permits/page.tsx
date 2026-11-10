'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PERMIT_KINDS, periodText } from '@/components/permits/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PermitFilters, type PermitKind, type StaffPermit } from '@/lib/queries';
import ar from '@/messages/ar/places-permits';
import en from '@/messages/en/places-permits';

const VIEWS = ['pending', 'live', 'all'] as const;
type View = (typeof VIEWS)[number];
type Kind = PermitKind | 'any';

/** The units' permits (ADR 0049): the queue to decide, and what is in force now. */
export default function PermitsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Segmented<Kind>
          label={t('kind')}
          value={kind}
          onChange={setKind}
          options={[{ value: 'any', label: t('kind.any') }, ...PERMIT_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffPermit>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={view === 'pending' ? t('emptyPending') : t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.permit'),
                cell: (p) => (
                  <Link className="table__link t-mono" href={`/permits/${p.id}`}>
                    {p.reference}
                  </Link>
                ),
              },
              { key: 'k', header: t('col.kind'), cell: (p) => t(`kind.${p.kind}`) },
              { key: 'u', header: t('col.unit'), cell: (p) => <span className="t-mono">{p.unitCode}</span> },
              { key: 'w', header: t('col.when'), cell: (p) => periodText(p, fmt, t) },
              { key: 'b', header: t('col.askedBy'), cell: (p) => p.requestedBy.fullName ?? '—' },
              { key: 's', header: t('col.status'), cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'c', header: t('col.asked'), cell: (p) => <span title={fmt.dateTime(p.createdAt)}>{fmt.relative(p.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
