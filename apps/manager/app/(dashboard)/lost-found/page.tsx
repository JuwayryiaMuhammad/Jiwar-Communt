'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { usePersonName } from '@/components/management-requests/bits';
import { excerpt, type Board, type PostState } from '@/components/neighbours/logic';
import { NewPostDialog } from '@/components/neighbours/new-post-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourPost } from '@/lib/queries';
import ar from '@/messages/ar/lf-posts';
import en from '@/messages/en/lf-posts';

/**
 * The lost-and-found desk and the lending board (ADR 0042). Found items are
 * held at the office: their claims and handovers are on each post's page.
 * The lending board is the residents' own: it is read here, and a post may
 * be taken down, nothing else. What residents write to each other about a
 * post is not reachable from the dashboard.
 */
export default function LostFoundPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const personName = usePersonName();
  const toast = useToast();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [board, setBoard] = useState<Board>('lost_found');
  const [state, setState] = useState<PostState>('open');
  const [creating, setCreating] = useState(false);
  const allowed = can('neighbours.handle');
  const filters = { board, state };
  const list = useCursorList(keys.neighbourPosts(filters), (cursor) => fetchers.neighbourPosts(filters, cursor), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;
  const desk = board === 'lost_found';
  const kindText = (kind: string) => (kind === 'lost' || kind === 'found' || kind === 'lend' || kind === 'borrow' ? t(`kind.${kind}`) : label(kind));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={desk ? t('description.desk') : t('description.lending')}
        actions={
          desk ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              {t('newPost')}
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Board>
          label={t('board')}
          value={board}
          onChange={setBoard}
          options={[
            { value: 'lost_found', label: t('board.lost_found') },
            { value: 'lending', label: t('board.lending') },
          ]}
        />
        <Segmented<PostState>
          label={t('shown')}
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: t('state.open') },
            { value: 'expired', label: t('state.expired') },
            { value: 'closed', label: t('state.closed') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<NeighbourPost>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t(`empty.${board}.${state}`)}
            emptyHint={state === 'expired' ? t('expiredHint') : undefined}
            columns={[
              { key: 'kind', header: c('kind'), cell: (p) => <Badge plain>{kindText(p.kind)}</Badge> },
              {
                key: 'body',
                header: t('col.post'),
                cell: (p) => (
                  <Link className="table__link" href={`/lost-found/${p.id}`}>
                    {p.body === null ? t('textRemoved') : excerpt(p.body) || t('open')}
                  </Link>
                ),
              },
              { key: 'place', header: t('col.place'), cell: (p) => p.place ?? <span className="t-secondary">—</span> },
              {
                key: 'date',
                header: desk ? t('col.day') : t('col.posted'),
                cell: (p) => (
                  <span title={t('postedOn', { when: f.dateTime(p.createdAt) })} style={{ whiteSpace: 'nowrap' }}>
                    {desk ? (p.occurredOn ? f.day(p.occurredOn) : <span className="t-secondary">—</span>) : f.date(p.createdAt)}
                  </span>
                ),
              },
              {
                key: 'author',
                header: t('col.author'),
                cell: (p) =>
                  p.authorSide === 'staff' ? (
                    <span title={personName(p.author)}>{t('management')}</span>
                  ) : (
                    <span className="stack stack--sm">
                      {personName(p.author)}
                      {p.authorUnit ? <span className="t-secondary">{t('unitCode', { code: p.authorUnit.code })}</span> : null}
                    </span>
                  ),
              },
              ...(desk
                ? [
                    {
                      key: 'claims',
                      header: t('col.claims'),
                      cell: (p: NeighbourPost) =>
                        p.pendingClaims > 0 ? <Badge tone="terracotta">{f.number(p.pendingClaims)}</Badge> : <span className="t-secondary">—</span>,
                    },
                  ]
                : []),
              {
                key: 'state',
                header: c('status'),
                cell: (p) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={p.state} />
                    {p.closeReason ? <span className="t-secondary">{label(p.closeReason)}</span> : null}
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
          toast.show(t('onBoard'));
          router.push(`/lost-found/${post.id}`);
        }}
      />
    </>
  );
}
