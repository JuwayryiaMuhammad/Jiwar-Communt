'use client';

import { humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TenderSummary } from '@/lib/queries';

type Status = TenderSummary['status'] | '';

/** The compound's tenders (ADR 0088): drafted, taking bids, opened by two people, awarded. */
export default function TendersPage() {
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('');
  const allowed = can('tenders.manage') || can('tenders.open');
  const filters = { status };
  const list = useCursorList(keys.tenders(filters), (c) => fetchers.tenders(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Tenders" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Tenders"
        description="Requests for bids: sealed until two people open them after the deadline; the award signs the contract."
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All' },
            { value: 'draft', label: 'Drafts' },
            { value: 'open', label: 'Taking bids' },
            { value: 'opening', label: 'Opening' },
            { value: 'opened', label: 'Opened' },
            { value: 'awarded', label: 'Awarded' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<TenderSummary>
            rows={list.rows}
            rowKey={(t) => t.id}
            empty="No tender"
            columns={[
              {
                key: 'r',
                header: 'Tender',
                cell: (t) => (
                  <Link className="table__link" href={`/tenders/${t.id}`}>
                    {t.reference} · {t.title}
                  </Link>
                ),
              },
              { key: 's', header: 'Status', cell: (t) => humanize(t.status) },
              { key: 'd', header: 'Bids until', cell: (t) => new Date(t.bidsDueAt).toLocaleString() },
              { key: 'n', header: 'Bids', cell: (t) => (t.bidCount === null ? 'Sealed' : String(t.bidCount)) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
