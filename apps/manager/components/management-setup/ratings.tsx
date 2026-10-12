'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable } from '@jiwar/ui';
import { Star } from 'lucide-react';
import Link from 'next/link';
import { personName } from '@/components/management-requests/bits';
import { fetchers, keys, type RequestRating } from '@/lib/queries';

/**
 * What residents said of closed requests, newest first (ADR 0039). For
 * `requests.manage` only: a handler never sees how their own request was
 * rated.
 */
export function Ratings() {
  const list = useCursorList(keys.requestRatings, (c) => fetchers.requestRatings(c));
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<RequestRating>
          rows={list.rows}
          rowKey={(r) => r.request.id}
          empty="No request was rated yet"
          emptyHint="A resident may rate a request once it is closed."
          columns={[
            {
              key: 'rating',
              header: 'Rating',
              cell: (r) => (
                <span className="row" style={{ gap: 4 }} title={`${r.rating} of 5`}>
                  <Star size={14} aria-hidden />
                  <span className="t-num">{r.rating}</span>
                </span>
              ),
            },
            {
              key: 'comment',
              header: 'Comment',
              cell: (r) => (r.comment ? <span style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</span> : <span className="t-secondary">—</span>),
            },
            {
              key: 'request',
              header: 'Request',
              cell: (r) => (
                <span className="stack stack--sm">
                  <Link className="table__link t-mono" href={`/management-requests/${r.request.id}`}>
                    {r.request.number}
                  </Link>
                  <span className="t-secondary">{r.request.topic.nameEn}</span>
                </span>
              ),
            },
            { key: 'resident', header: 'Resident', cell: (r) => personName(r.request.author) },
            {
              key: 'handler',
              header: 'Handled by',
              cell: (r) => (r.request.assignee ? personName(r.request.assignee) : <span className="t-secondary">Unassigned</span>),
            },
            { key: 'when', header: 'Rated', cell: (r) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}
