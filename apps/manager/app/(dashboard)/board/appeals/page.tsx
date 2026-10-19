'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { APPEAL_KIND_TEXT } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardAppealStatus, type StaffBoardAppeal } from '@/lib/queries';

/** Appeals to the board (ADR 0055): staff decisions a unit asked the board to review. */
export default function BoardAppealsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<BoardAppealStatus>('pending');
  const list = useCursorList(keys.boardAppeals(status), (c) => fetchers.boardAppeals(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Appeals to the board" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Appeals to the board"
        description="A unit’s owner or primary asks the board to review a staff decision. Members who live in or own the unit, or appealed, are recused."
      />
      <div className="toolbar">
        <Segmented<BoardAppealStatus>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'To decide' },
            { value: 'upheld', label: 'Upheld' },
            { value: 'overturned', label: 'Overturned' },
            { value: 'withdrawn', label: 'Withdrawn' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffBoardAppeal>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="Nothing here"
            columns={[
              { key: 'r', header: 'Appeal', cell: (a) => <Link href={`/board/appeals/${a.id}`}>{a.reference}</Link> },
              { key: 'k', header: 'Of', cell: (a) => APPEAL_KIND_TEXT[a.kind] },
              { key: 'u', header: 'Unit', cell: (a) => <span className="t-mono">{a.unitCode}</span> },
              { key: 'l', header: 'Lodged', cell: (a) => formatDateTime(a.lodgedAt) },
              { key: 'd', header: 'Deadline', cell: (a) => `${formatDateTime(a.deadlineAt)}${a.overdue ? ' · overdue' : ''}` },
              { key: 's', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
