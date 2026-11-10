'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Card, CardBody, CardHeader, ForbiddenState, PageHeader, StatusBadge, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { usePersonName } from '@/components/management-requests/bits';
import { Back, Evidence, PersonLink } from '@/components/neighbours/bits';
import { postActionsFor } from '@/components/neighbours/logic';
import { Claims, Handover, RemovePost } from '@/components/neighbours/post-desk';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourPost } from '@/lib/queries';
import ar from '@/messages/ar/lf-posts';
import en from '@/messages/en/lf-posts';

function useKindText() {
  const t = useT(en, ar);
  const label = useLabel();
  return (kind: string) => (kind === 'lost' || kind === 'found' || kind === 'lend' || kind === 'borrow' ? t(`kind.${kind}`) : label(kind));
}

function Details({ post }: { post: NeighbourPost }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const personName = usePersonName();
  const desk = post.board === 'lost_found';
  return (
    <Card flush>
      <CardHeader title={t('post')} />
      <CardBody>
        <dl className="dl">
          <dt>{t('detail.board')}</dt>
          <dd>{desk ? t('board.lost_found') : t('board.lending')}</dd>
          <dt>{t('detail.author')}</dt>
          <dd>
            {post.authorSide === 'staff' ? (
              <>{t('managementAuthor', { name: personName(post.author) })}</>
            ) : (
              <>
                <PersonLink person={post.author} />
                {post.authorUnit
                  ? ` · ${
                      post.authorUnit.building
                        ? t('unitLineBuilding', { code: post.authorUnit.code, building: post.authorUnit.building })
                        : t('unitLine', { code: post.authorUnit.code })
                    }`
                  : ''}
              </>
            )}
          </dd>
          <dt>{t('detail.place')}</dt>
          <dd>{post.place ?? <span className="t-secondary">{t('notGiven')}</span>}</dd>
          {desk ? (
            <>
              <dt>{post.kind === 'found' ? t('foundOn') : t('lostOn')}</dt>
              <dd>{post.occurredOn ? f.day(post.occurredOn) : <span className="t-secondary">{t('notGiven')}</span>}</dd>
            </>
          ) : null}
          <dt>{t('detail.posted')}</dt>
          <dd>{f.dateTime(post.createdAt)}</dd>
          <dt>{post.state === 'open' ? t('onBoardUntil') : t('itsDayWas')}</dt>
          <dd>{f.dateTime(post.expiresAt)}</dd>
          {post.closedAt ? (
            <>
              <dt>{t('detail.closed')}</dt>
              <dd>
                {f.dateTime(post.closedAt)} · {label(post.closeReason)}
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
  const t = useT(en, ar);
  const personName = usePersonName();
  const kindText = useKindText();
  const { id } = useParams<{ id: string }>();
  const { can, ready } = usePermissions();
  const allowed = can('neighbours.handle');
  const post = useQuery({ queryKey: keys.neighbourPost(id), queryFn: () => fetchers.neighbourPost(id), refetchInterval: 60_000, enabled: allowed });
  const p = post.data;
  const back = <Back href="/lost-found" label={t('title')} />;

  if (ready && !allowed) {
    return (
      <>
        <PageHeader back={back} title={t('post')} />
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
              {kindText(p.kind)}
              <StatusBadge status={p.state} />
              {p.pendingClaims > 0 ? <Badge tone="terracotta">{t('claimsWaiting', { n: p.pendingClaims })}</Badge> : null}
            </span>
          ) : (
            t('post')
          )
        }
        description={p ? (p.authorSide === 'staff' ? t('postedByManagement') : t('postedBy', { name: personName(p.author) })) : undefined}
        actions={p ? <RemovePost post={p} /> : undefined}
      />
      <QueryState query={post}>
        {p && may ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title={t('whatItSays')} />
                <CardBody>
                  {p.body === null ? (
                    <p className="t-secondary">{t('removedBody')}</p>
                  ) : (
                    <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{p.body}</p>
                  )}
                  <Evidence items={p.photos} alt={t('photoAlt')} />
                </CardBody>
              </Card>
              {p.board === 'lending' ? <Alert>{t('lendingNote')}</Alert> : p.kind === 'lost' ? <Alert>{t('lostNote')}</Alert> : null}
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
