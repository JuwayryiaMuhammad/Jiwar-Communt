'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TenderSummary } from '@/lib/queries';
import ar from '@/messages/ar/ops-tenders';
import en from '@/messages/en/ops-tenders';

type Status = TenderSummary['status'] | '';
const VIEWS = ['', 'draft', 'open', 'opening', 'opened', 'awarded'] as const;

/** The compound's tenders (ADR 0088): drafted, taking bids, opened by two people, awarded. */
export default function TendersPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('');
  const allowed = can('tenders.manage') || can('tenders.open');
  const filters = { status };
  const list = useCursorList(keys.tenders(filters), (c) => fetchers.tenders(filters, c), { enabled: allowed });
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
        <Segmented<Status>
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<TenderSummary>
            rows={list.rows}
            rowKey={(x) => x.id}
            empty={t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.tender'),
                cell: (x) => (
                  <Link className="table__link" href={`/tenders/${x.id}`}>
                    <bdi>{x.reference}</bdi> · {x.title}
                  </Link>
                ),
              },
              { key: 's', header: t('col.status'), cell: (x) => t(`status.${x.status}`) },
              { key: 'd', header: t('col.bidsUntil'), cell: (x) => fmt.dateTime(x.bidsDueAt) },
              { key: 'n', header: t('col.bids'), cell: (x) => (x.bidCount === null ? t('sealed') : fmt.number(x.bidCount)) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
