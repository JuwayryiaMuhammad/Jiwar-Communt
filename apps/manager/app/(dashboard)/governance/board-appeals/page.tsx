'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { APPEAL_KIND_TEXT, EFFECT_TEXT } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardAppealStatus, type StaffBoardAppeal } from '@/lib/queries';

/**
 * Appeals to the board (ADR 0055), as the management, a party to them,
 * sees them: where each stands and the board's reasons; never the grounds
 * or the deliberation.
 */
export default function StaffBoardAppealsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [status, setStatus] = useState<BoardAppealStatus>('pending');
  const list = useCursorList(keys.staffBoardAppeals(status), (c) => fetchers.staffBoardAppeals(status, c), { enabled: allowed });
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
        description="A unit took a staff decision to the board. A pending appeal holds a fine’s or a violation’s payment; an overturn the system cannot apply waits for you to follow it up."
      />
      <div className="toolbar">
        <Segmented<BoardAppealStatus>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'With the board' },
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
              { key: 'r', header: 'Appeal', cell: (a) => <Link href={`/governance/board-appeals/${a.id}`}>{a.reference}</Link> },
              { key: 'k', header: 'Of', cell: (a) => APPEAL_KIND_TEXT[a.kind] },
              // A complaint about the management never names its unit to the staff (ADR 0059).
              { key: 'u', header: 'Unit', cell: (a) => (a.unitCode ? <span className="t-mono">{a.unitCode}</span> : '—') },
              { key: 'd', header: 'Deadline', cell: (a) => `${formatDateTime(a.deadlineAt)}${a.overdue ? ' · overdue' : ''}` },
              { key: 's', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              {
                key: 'e',
                header: 'Effect',
                cell: (a) =>
                  a.effect === 'follow_up' && !a.followedUpAt ? <strong>{EFFECT_TEXT.follow_up}</strong> : a.effect ? EFFECT_TEXT[a.effect] : '—',
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
