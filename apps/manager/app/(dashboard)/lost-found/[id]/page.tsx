'use client';

import { formatDate, formatDateTime, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Alert, Badge, Card, CardBody, CardHeader, ForbiddenState, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back, Evidence, personName, PersonLink } from '@/components/neighbours/bits';
import { KIND_TEXT, postActionsFor } from '@/components/neighbours/logic';
import { Claims, Handover, RemovePost } from '@/components/neighbours/post-desk';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourPost } from '@/lib/queries';

function Details({ post }: { post: NeighbourPost }) {
  const desk = post.board === 'lost_found';
  return (
    <Card flush>
      <CardHeader title="Post" />
      <CardBody>
        <dl className="dl">
          <dt>Board</dt>
          <dd>{desk ? 'Lost & found' : 'Lending'}</dd>
          <dt>Author</dt>
          <dd>
            {post.authorSide === 'staff' ? (
              <>Management · {personName(post.author)}</>
            ) : (
              <>
                <PersonLink person={post.author} />
                {post.authorUnit ? ` · unit ${post.authorUnit.code}${post.authorUnit.building ? ` · ${post.authorUnit.building}` : ''}` : ''}
              </>
            )}
          </dd>
          <dt>Place</dt>
          <dd>{post.place ?? <span className="t-secondary">Not given</span>}</dd>
          {desk ? (
            <>
              <dt>{post.kind === 'found' ? 'Found on' : 'Lost on'}</dt>
              <dd>{post.occurredOn ? formatDate(post.occurredOn) : <span className="t-secondary">Not given</span>}</dd>
            </>
          ) : null}
          <dt>Posted</dt>
          <dd>{formatDateTime(post.createdAt)}</dd>
          <dt>{post.state === 'open' ? 'On the board until' : 'Its day was'}</dt>
          <dd>{formatDateTime(post.expiresAt)}</dd>
          {post.closedAt ? (
            <>
              <dt>Closed</dt>
              <dd>
                {formatDateTime(post.closedAt)} · {humanize(post.closeReason)}
              </dd>
            </>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  );
}

/**
 * One post of the boards (ADR 0042). A found item shows its claims and its
 * handover; a lost item and a lending post are read, and may be removed.
 */
export default function NeighbourPostPage() {
  const { id } = useParams<{ id: string }>();
  const { can, ready } = usePermissions();
  const allowed = can('neighbours.handle');
  const post = useQuery({ queryKey: keys.neighbourPost(id), queryFn: () => fetchers.neighbourPost(id), refetchInterval: 60_000, enabled: allowed });
  const p = post.data;
  const back = <Back href="/lost-found" label="Lost & found" />;

  if (ready && !allowed) {
    return (
      <>
        <PageHeader back={back} title="Post" />
        <ForbiddenState />
      </>
    );
  }
  const may = p ? postActionsFor(p) : null;

  return (
    <>
      <PageHeader
        back={back}
        title={
          p ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {KIND_TEXT[p.kind] ?? p.kind}
              <StatusBadge status={p.state} />
              {p.pendingClaims > 0 ? <Badge tone="terracotta">{p.pendingClaims === 1 ? '1 claim waiting' : `${p.pendingClaims} claims waiting`}</Badge> : null}
            </span>
          ) : (
            'Post'
          )
        }
        description={p ? (p.authorSide === 'staff' ? 'Posted by the management' : `Posted by ${personName(p.author)}`) : undefined}
        actions={p ? <RemovePost post={p} /> : undefined}
      />
      <QueryState query={post}>
        {p && may ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title="What it says" />
                <CardBody>
                  {p.body === null ? <p className="t-secondary">Text removed: its author was erased.</p> : <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{p.body}</p>}
                  <Evidence items={p.photos} alt="Photo of the item" />
                </CardBody>
              </Card>
              {p.board === 'lending' ? (
                <Alert>
                  The lending board is the residents’ own. This post is read here and may be removed; what residents write to each other about it is
                  not shown.
                </Alert>
              ) : p.kind === 'lost' ? (
                <Alert>A lost item is not held at the office: there is nothing to claim or hand over here.</Alert>
              ) : null}
              <Handover post={p} />
              <Claims post={p} />
            </div>
            <div className="stack">
              <Details post={p} />
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
