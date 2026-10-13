'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, StatusBadge } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TwoLanguages } from '@/components/community/bits';
import { audienceText } from '@/components/community/logic';
import { PollDialog } from '@/components/community/poll-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Poll, type PollFilters } from '@/lib/queries';

const STATUSES: Poll['status'][] = ['scheduled', 'open', 'closed', 'cancelled'];

/** The compound's consultative polls (ADR 0040), the newest first. */
export default function PollsPage() {
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<Poll['status'] | ''>('');
  const [creating, setCreating] = useState(false);
  const allowed = can('community.publish');
  const filters: PollFilters = { status };
  const list = useCursorList(keys.polls(filters), (c) => fetchers.polls(filters, c), { enabled: allowed, refetchInterval: 60_000 });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title="Polls"
        description="Consultative polls: one vote per unit, by secret ballot. They ask residents what they think; they decide nothing by themselves."
      />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Poll['status'] | '')}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          New poll
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Poll>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No poll here"
            columns={[
              {
                key: 'question',
                header: 'Question',
                cell: (p) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/polls/${p.id}`}>
                      <TwoLanguages en={p.questionEn} ar={p.questionAr} strong />
                    </Link>
                    {p.multiple ? (
                      <span>
                        <Badge plain>Several choices</Badge>
                      </span>
                    ) : null}
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              {
                key: 'turnout',
                header: 'Units voted',
                cell: (p) =>
                  p.turnout === null ? (
                    <span className="t-secondary">{p.resultsHidden === 'few_votes' ? 'Fewer than 5' : 'None'}</span>
                  ) : (
                    p.turnout
                  ),
              },
              { key: 'closes', header: 'Closes', cell: (p) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(p.closesAt)}</span> },
              { key: 'audience', header: 'Audience', cell: (p) => audienceText(p.audience) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? (
        <PollDialog
          poll={null}
          open
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            router.push(`/polls/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
