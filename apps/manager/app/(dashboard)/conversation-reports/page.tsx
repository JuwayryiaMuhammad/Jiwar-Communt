'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { personName } from '@/components/neighbours/bits';
import { excerpt, KIND_TEXT, SIDE_TEXT } from '@/components/neighbours/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ConversationReport } from '@/lib/queries';

type Status = ConversationReport['status'];

/**
 * Conversations between two residents that one of them reported (ADR
 * 0042). A conversation is private to the two; the staff read it only as a
 * case, and only while the case is open.
 */
export default function ConversationReportsPage() {
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
        title="Conversation reports"
        description="Conversations about a post that one of the two residents reported. A conversation is read here only while its case is open; closing the case seals it again."
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Cases shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ConversationReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={status === 'open' ? 'No reported conversation is waiting' : 'No case was closed'}
            columns={[
              {
                key: 'reason',
                header: 'Reported for',
                cell: (r) => (
                  <Link className="table__link" href={`/conversation-reports/${r.id}`}>
                    {humanize(r.reasonCode)}
                  </Link>
                ),
              },
              {
                key: 'reporter',
                header: 'Reported by',
                cell: (r) => (
                  <span className="stack stack--sm">
                    {personName(r.reporter)}
                    <span className="t-secondary">{SIDE_TEXT[r.reporterSide] ?? r.reporterSide}</span>
                  </span>
                ),
              },
              {
                key: 'about',
                header: 'About',
                cell: (r) => {
                  const other = r.reporterSide === 'author' ? r.responder : r.author;
                  return (
                    <span className="stack stack--sm">
                      {personName(other.account)}
                      {other.unitCode ? <span className="t-secondary">Unit {other.unitCode}</span> : null}
                    </span>
                  );
                },
              },
              {
                key: 'post',
                header: 'Post',
                cell: (r) => (
                  <span className="row" style={{ gap: 8 }}>
                    <Badge plain>{KIND_TEXT[r.post.kind] ?? r.post.kind}</Badge>
                    <span className="t-secondary" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {excerpt(r.post.body, 60)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Case',
                cell: (r) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={r.status} />
                    {r.outcome ? <span className="t-secondary">{humanize(r.outcome)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'at',
                header: status === 'open' ? 'Reported' : 'Closed',
                cell: (r) => {
                  const at = status === 'open' ? r.createdAt : (r.closedAt ?? r.createdAt);
                  return (
                    <span title={formatDateTime(at)} style={{ whiteSpace: 'nowrap' }}>
                      {relativeTime(at)}
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
