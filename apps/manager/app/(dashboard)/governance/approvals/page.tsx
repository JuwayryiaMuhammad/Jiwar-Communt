'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { approvalStatus } from '@/components/governance/board-ui';
import { APPROVAL_TYPE_TEXT } from '@/components/governance/matters';
import { RaiseApproval } from '@/components/governance/raise';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Approval, type ApprovalFilter } from '@/lib/queries';

/** Matters raised for the board (ADR 0055), as the management follows them: never a motion or a vote. */
export default function ApprovalsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.approvals');
  const [status, setStatus] = useState<ApprovalFilter>('pending');
  const [raising, setRaising] = useState(false);
  const list = useCursorList(keys.approvals(status), (c) => fetchers.approvals(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Approvals" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Approvals"
        description="What the owners’ board decides: a contract above the manager’s limit, a budget increase, a fee, a waiver or a plan above its limit, a legal step. Annual budgets are submitted from their page."
        actions={
          <Button variant="primary" onClick={() => setRaising(true)}>
            Raise
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<ApprovalFilter>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'With the board' },
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
              { key: 'r', header: 'Request', cell: (a) => <Link href={`/governance/approvals/${a.id}`}>{a.reference}</Link> },
              { key: 't', header: 'Type', cell: (a) => APPROVAL_TYPE_TEXT[a.type] },
              { key: 'c', header: 'Cost', cell: (a) => (a.cost ? egp(a.cost) : '—') },
              { key: 'm', header: 'Raised', cell: (a) => `${formatDateTime(a.raisedAt)}${a.raisedByMe ? ' · by you' : ''}` },
              { key: 'd', header: 'Deadline', cell: (a) => `${formatDateTime(a.deadlineAt)}${a.overdue ? ' · overdue' : ''}` },
              { key: 's', header: 'Status', cell: (a) => <StatusBadge status={approvalStatus(a)} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {raising ? <RaiseApproval onClose={() => setRaising(false)} /> : null}
    </>
  );
}
