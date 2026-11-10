'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Suggestion, type SuggestionFilters, type SuggestionStatus } from '@/lib/queries';
import ar from '@/messages/ar/community-suggestions';
import en from '@/messages/en/community-suggestions';

const STATUSES: SuggestionStatus[] = ['received', 'under_review', 'planned', 'deferred', 'done', 'declined'];
const BOARDS = ['all', 'true', 'false'] as const;
type Board = (typeof BOARDS)[number];

/**
 * What residents suggested (ADR 0040), the newest first. Each is private
 * to its author until the staff put it on the board, under a summary of
 * their own and without the author.
 */
export default function SuggestionsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<SuggestionStatus | ''>('');
  const [topicId, setTopicId] = useState('');
  const [board, setBoard] = useState<Board>('all');
  const allowed = can('community.suggestions');
  const filters: SuggestionFilters = { status, topicId, published: board === 'all' ? '' : board };
  const topics = useQuery({ queryKey: keys.suggestionTopics, queryFn: fetchers.suggestionTopics, enabled: allowed });
  const list = useCursorList(keys.suggestions(filters), (c) => fetchers.suggestions(filters, c), { enabled: allowed, refetchInterval: 120_000 });
  const topicName = (x: { nameEn: string; nameAr: string }) => (locale === 'ar' ? x.nameAr : x.nameEn);

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Board>
          label={t('shown')}
          value={board}
          onChange={setBoard}
          options={BOARDS.map((v) => ({ value: v, label: t(`board.${v}`) }))}
        />
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as SuggestionStatus | '')}>
              <option value="">{t('anyStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('topic')}>
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">{t('anyTopic')}</option>
              {(topics.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {topicName(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Suggestion>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={t('empty')}
            columns={[
              {
                key: 'body',
                header: t('col.suggestion'),
                cell: (s) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/suggestions/${s.id}`}>
                      <span
                        dir="auto"
                        style={{ display: 'block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {s.body ?? t('erasedBody')}
                      </span>
                    </Link>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {s.publishedAt ? <Badge tone="green">{t('onBoard', { n: s.supports })}</Badge> : null}
                      {s.done?.noteEn || s.done?.noteAr ? <Badge plain>{t('weDid')}</Badge> : null}
                    </span>
                  </span>
                ),
              },
              {
                key: 'author',
                header: t('col.resident'),
                cell: (s) => (
                  <span className="stack stack--sm">
                    {s.author.fullName ?? <span className="t-secondary">{t('erased')}</span>}
                    {s.unitCode ? <span className="t-secondary">{t('unit', { unit: s.unitCode })}</span> : null}
                  </span>
                ),
              },
              { key: 'topic', header: t('col.topic'), cell: (s) => topicName(s.topic) },
              { key: 'status', header: t('col.status'), cell: (s) => <StatusBadge status={s.status} /> },
              { key: 'when', header: t('col.received'), cell: (s) => <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(s.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
