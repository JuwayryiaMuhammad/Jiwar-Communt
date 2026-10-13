'use client';

import { formatDate, formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { personName } from '@/components/neighbours/bits';
import { boardEmptyText, excerpt, KIND_TEXT, type Board, type PostState } from '@/components/neighbours/logic';
import { NewPostDialog } from '@/components/neighbours/new-post-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourPost } from '@/lib/queries';

/**
 * The lost-and-found desk and the lending board (ADR 0042). Found items are
 * held at the office: their claims and handovers are on each post's page.
 * The lending board is the residents' own: it is read here, and a post may
 * be taken down, nothing else. What residents write to each other about a
 * post is not reachable from the dashboard.
 */
export default function LostFoundPage() {
  const toast = useToast();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [board, setBoard] = useState<Board>('lost_found');
  const [state, setState] = useState<PostState>('open');
  const [creating, setCreating] = useState(false);
  const allowed = can('neighbours.handle');
  const filters = { board, state };
  const list = useCursorList(keys.neighbourPosts(filters), (c) => fetchers.neighbourPosts(filters, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;
  const desk = board === 'lost_found';

  return (
    <>
      <PageHeader
        title="Lost & found"
        description={
          desk
            ? 'What was lost and what was found. A found item is kept at the office until its owner claims it and it is handed over.'
            : 'What residents offer to lend and ask to borrow. Read-only here: a post may be removed, and nothing residents write to each other is shown.'
        }
        actions={
          desk ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              New post
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Board>
          label="Board"
          value={board}
          onChange={setBoard}
          options={[
            { value: 'lost_found', label: 'Lost & found' },
            { value: 'lending', label: 'Lending' },
          ]}
        />
        <Segmented<PostState>
          label="Posts shown"
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'expired', label: 'Expired' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<NeighbourPost>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={boardEmptyText(board, state)}
            emptyHint={state === 'expired' ? 'An expired post left its board when its day passed, and nobody closed it.' : undefined}
            columns={[
              { key: 'kind', header: 'Kind', cell: (p) => <Badge plain>{KIND_TEXT[p.kind] ?? p.kind}</Badge> },
              {
                key: 'body',
                header: 'Post',
                cell: (p) => (
                  <Link className="table__link" href={`/lost-found/${p.id}`}>
                    {p.body === null ? 'Text removed' : excerpt(p.body) || 'Open'}
                  </Link>
                ),
              },
              { key: 'place', header: 'Place', cell: (p) => p.place ?? <span className="t-secondary">—</span> },
              {
                key: 'date',
                header: desk ? 'Day' : 'Posted',
                cell: (p) => (
                  <span title={`Posted ${formatDateTime(p.createdAt)}`} style={{ whiteSpace: 'nowrap' }}>
                    {desk ? (p.occurredOn ? formatDate(p.occurredOn) : <span className="t-secondary">—</span>) : formatDate(p.createdAt)}
                  </span>
                ),
              },
              {
                key: 'author',
                header: 'Author',
                cell: (p) =>
                  p.authorSide === 'staff' ? (
                    <span title={personName(p.author)}>Management</span>
                  ) : (
                    <span className="stack stack--sm">
                      {personName(p.author)}
                      {p.authorUnit ? <span className="t-secondary">Unit {p.authorUnit.code}</span> : null}
                    </span>
                  ),
              },
              ...(desk
                ? [
                    {
                      key: 'claims',
                      header: 'Pending claims',
                      cell: (p: NeighbourPost) =>
                        p.pendingClaims > 0 ? <Badge tone="terracotta">{p.pendingClaims}</Badge> : <span className="t-secondary">—</span>,
                    },
                  ]
                : []),
              {
                key: 'state',
                header: 'State',
                cell: (p) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={p.state} />
                    {p.closeReason ? <span className="t-secondary">{p.closeReason.replace(/_/g, ' ')}</span> : null}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewPostDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(post) => {
          setCreating(false);
          toast.show('The item is on the board.');
          router.push(`/lost-found/${post.id}`);
        }}
      />
    </>
  );
}
