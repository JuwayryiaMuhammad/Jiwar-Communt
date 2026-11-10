'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Card, DataTable } from '@jiwar/ui';
import { Star } from 'lucide-react';
import Link from 'next/link';
import { usePersonName } from '@/components/management-requests/bits';
import { localName } from '@/components/management-requests/logic';
import { fetchers, keys, type RequestRating } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-setup';
import en from '@/messages/en/services-mgmt-setup';

/**
 * What residents said of closed requests, newest first (ADR 0039). For
 * `requests.manage` only: a handler never sees how their own request was
 * rated.
 */
export function Ratings() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const personName = usePersonName();
  const list = useCursorList(keys.requestRatings, (c) => fetchers.requestRatings(c));
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<RequestRating>
          rows={list.rows}
          rowKey={(r) => r.request.id}
          empty={t('ratingsEmpty')}
          emptyHint={t('ratingsEmptyHint')}
          columns={[
            {
              key: 'rating',
              header: t('col.rating'),
              cell: (r) => (
                <span className="row" style={{ gap: 4 }} title={t('ratingOf', { n: r.rating })}>
                  <Star size={14} aria-hidden />
                  <span className="t-num">{r.rating}</span>
                </span>
              ),
            },
            {
              key: 'comment',
              header: t('col.comment'),
              cell: (r) => (r.comment ? <span style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</span> : <span className="t-secondary">—</span>),
            },
            {
              key: 'request',
              header: t('col.request'),
              cell: (r) => (
                <span className="stack stack--sm">
                  <Link className="table__link t-mono" href={`/management-requests/${r.request.id}`}>
                    {r.request.number}
                  </Link>
                  <span className="t-secondary">{localName(locale, r.request.topic)}</span>
                </span>
              ),
            },
            { key: 'resident', header: t('col.resident'), cell: (r) => personName(r.request.author) },
            {
              key: 'handler',
              header: t('col.handler'),
              cell: (r) => (r.request.assignee ? personName(r.request.assignee) : <span className="t-secondary">{t('unassigned')}</span>),
            },
            { key: 'when', header: t('col.rated'), cell: (r) => <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(r.createdAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}
