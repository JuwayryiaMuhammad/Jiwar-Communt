'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AgendaProposal, type AgendaProposalStatus } from '@/lib/queries';

/**
 * The owners' proposals for the board's agenda (ADR 0059), a sitting
 * member's page: what waits for an answer, and the rest. Never who proposed.
 */
export default function BoardAgendaPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<AgendaProposalStatus>('open');
  const list = useCursorList(keys.boardAgenda(status), (c) => fetchers.boardAgenda(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Agenda proposals" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Agenda proposals"
        description="Matters the owners asked the board to take up. A sitting member accepts or declines each, once; accepting binds the board to nothing."
      />
      <div className="toolbar">
        <Segmented<AgendaProposalStatus>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'To answer' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'declined', label: 'Declined' },
            { value: 'withdrawn', label: 'Withdrawn' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AgendaProposal>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="Nothing here"
            columns={[
              {
                key: 't',
                header: 'Proposal',
                cell: (p) => <Link href={`/board/agenda/${p.id}`}>{p.title ?? 'Removed: its proposer’s account was erased'}</Link>,
              },
              { key: 'c', header: 'Proposed', cell: (p) => formatDateTime(p.createdAt) },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
