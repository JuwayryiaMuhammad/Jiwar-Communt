'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { approvalStatus } from '@/components/governance/board-ui';
import { APPROVAL_TYPE_TEXT } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Approval, type ApprovalFilter } from '@/lib/queries';

/** The board's inbox (ADR 0055): what awaits it, what awaits the management, and the history. */
export default function BoardInboxPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<ApprovalFilter>('pending');
  const list = useCursorList(keys.boardInbox(status), (c) => fetchers.boardInbox(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="The board’s inbox" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="The board’s inbox"
        description="Requests the management raised for the board to decide, each with its context, costs and alternatives."
      />
      <div className="toolbar">
        <Segmented<ApprovalFilter>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'To decide' },
            { value: 'approved', label: 'Approved, to implement' },
            { value: 'implemented', label: 'Implemented' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'withdrawn', label: 'Withdrawn' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Approval>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="Nothing here"
            columns={[
              { key: 'r', header: 'Request', cell: (a) => <Link href={`/board/approvals/${a.id}`}>{a.reference}</Link> },
              { key: 't', header: 'Type', cell: (a) => APPROVAL_TYPE_TEXT[a.type] },
              { key: 'c', header: 'Cost', cell: (a) => (a.cost ? egp(a.cost) : '—') },
              { key: 'd', header: 'Deadline', cell: (a) => `${formatDateTime(a.deadlineAt)}${a.overdue ? ' · overdue' : ''}` },
              { key: 's', header: 'Status', cell: (a) => <StatusBadge status={approvalStatus(a)} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
