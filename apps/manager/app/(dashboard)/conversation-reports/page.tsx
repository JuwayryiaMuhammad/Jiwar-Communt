'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { excerpt } from '@/components/neighbours/logic';
import { useWho } from '@/components/neighbours/who';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ConversationReport } from '@/lib/queries';
import ar from '@/messages/ar/conv-reports';
import en from '@/messages/en/conv-reports';

type Status = ConversationReport['status'];

/**
 * Conversations between two residents that one of them reported (ADR
 * 0042). A conversation is private to the two; the staff read it only as a
 * case, and only while the case is open.
 */
export default function ConversationReportsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const who = useWho();
  const kindText = (kind: string) => (kind === 'lost' || kind === 'found' || kind === 'lend' || kind === 'borrow' ? t(`kind.${kind}`) : label(kind));
  const sideText = (side: string) => (side === 'author' || side === 'responder' ? t(`side.${side}`) : label(side));
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<Status>('open');
  const allowed = can('neighbours.handle');
  const list = useCursorList(keys.conversationReports(status), (c) => fetchers.conversationReports(status, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<Status>
          label={t('casesShown')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: label('open') },
            { value: 'closed', label: label('closed') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ConversationReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={status === 'open' ? t('emptyOpen') : t('emptyClosed')}
            columns={[
              {
                key: 'reason',
                header: t('reportedFor'),
                cell: (r) => (
                  <Link className="table__link" href={`/conversation-reports/${r.id}`}>
                    {label(r.reasonCode)}
                  </Link>
                ),
              },
              {
                key: 'reporter',
                header: t('reportedBy'),
                cell: (r) => (
                  <span className="stack stack--sm">
                    {who.person(r.reporter)}
                    <span className="t-secondary">{sideText(r.reporterSide)}</span>
                  </span>
                ),
              },
              {
                key: 'about',
                header: t('about'),
                cell: (r) => {
                  const other = r.reporterSide === 'author' ? r.responder : r.author;
                  return (
                    <span className="stack stack--sm">
                      {who.person(other.account)}
                      {other.unitCode ? <span className="t-secondary">{t('unitCode', { code: other.unitCode })}</span> : null}
                    </span>
                  );
                },
              },
              {
                key: 'post',
                header: t('post'),
                cell: (r) => (
                  <span className="row" style={{ gap: 8 }}>
                    {/* A board post, or a market listing (ADR 0071). */}
                    <Badge plain>{r.post ? kindText(r.post.kind) : t('listing', { kind: r.listing?.kind ? kindText(r.listing.kind) : '' })}</Badge>
                    <span className="t-secondary" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {excerpt(r.post ? r.post.body : (r.listing?.title ?? null), 60)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: t('case'),
                cell: (r) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={r.status} />
                    {r.outcome ? <span className="t-secondary">{label(r.outcome)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'at',
                header: status === 'open' ? t('reported') : t('closed'),
                cell: (r) => {
                  const at = status === 'open' ? r.createdAt : (r.closedAt ?? r.createdAt);
                  return (
                    <span title={f.dateTime(at)} style={{ whiteSpace: 'nowrap' }}>
                      {f.relative(at)}
                    </span>
                  );
                },
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
