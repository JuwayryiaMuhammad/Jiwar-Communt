'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Suggestion, type SuggestionFilters, type SuggestionStatus } from '@/lib/queries';

const STATUSES: SuggestionStatus[] = ['received', 'under_review', 'planned', 'done', 'declined'];
type Board = 'all' | 'true' | 'false';

/**
 * What residents suggested (ADR 0040), the newest first. Each is private
 * to its author until the staff put it on the board, under a summary of
 * their own and without the author.
 */
export default function SuggestionsPage() {
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<SuggestionStatus | ''>('');
  const [topicId, setTopicId] = useState('');
  const [board, setBoard] = useState<Board>('all');
  const allowed = can('community.suggestions');
  const filters: SuggestionFilters = { status, topicId, published: board === 'all' ? '' : board };
  const topics = useQuery({ queryKey: keys.suggestionTopics, queryFn: fetchers.suggestionTopics, enabled: allowed });
  const list = useCursorList(keys.suggestions(filters), (c) => fetchers.suggestions(filters, c), { enabled: allowed, refetchInterval: 120_000 });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title="Suggestions"
        description="What residents suggest. A suggestion is private to its author; on the public board it is shown by a summary you write, never by their words or their name."
      />
      <div className="toolbar">
        <Segmented<Board>
          label="Suggestions shown"
          value={board}
          onChange={setBoard}
          options={[
            { value: 'all', label: 'All' },
            { value: 'true', label: 'On the board' },
            { value: 'false', label: 'Not on the board' },
          ]}
        />
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as SuggestionStatus | '')}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Topic">
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">Any topic</option>
              {(topics.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nameEn}
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
            empty="No suggestion here"
            columns={[
              {
                key: 'body',
                header: 'Suggestion',
                cell: (s) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/suggestions/${s.id}`}>
                      <span style={{ display: 'block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.body ?? 'Erased with its author’s account'}
                      </span>
                    </Link>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {s.publishedAt ? <Badge tone="green">On the board · {s.supports} support</Badge> : null}
                      {s.done?.noteEn || s.done?.noteAr ? <Badge plain>We did</Badge> : null}
                    </span>
                  </span>
                ),
              },
              {
                key: 'author',
                header: 'Resident',
                cell: (s) => (
                  <span className="stack stack--sm">
                    {s.author.fullName ?? <span className="t-secondary">Erased account</span>}
                    {s.unitCode ? <span className="t-secondary">Unit {s.unitCode}</span> : null}
                  </span>
                ),
              },
              { key: 'topic', header: 'Topic', cell: (s) => s.topic.nameEn },
              { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
              { key: 'when', header: 'Received', cell: (s) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
