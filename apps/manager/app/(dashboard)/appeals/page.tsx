'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { EFFECT_TEXT, KIND_TEXT } from '@/components/appeals/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DecisionAppeal, type DecisionAppealStatus } from '@/lib/queries';

/**
 * Decision appeals (ADR 0059): residents' appeals of a staff decision about
 * their unit, decided by a manager who did not take it.
 */
export default function DecisionAppealsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('appeals.decide');
  const [status, setStatus] = useState<DecisionAppealStatus | ''>('pending');
  const list = useCursorList(keys.decisionAppeals(status), (c) => fetchers.decisionAppeals(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Decision appeals" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Decision appeals"
        description="A rejected permit, vehicle or worker, or a neighbour notice, appealed by those it is about. Another manager than the one who decided upholds or overturns it; an overturn runs the normal approval with all its checks."
      />
      <div className="toolbar">
        <Segmented<DecisionAppealStatus | ''>
          label="Appeals shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'To decide' },
            { value: 'overturned', label: 'Overturned' },
            { value: 'upheld', label: 'Upheld' },
            { value: 'withdrawn', label: 'Withdrawn' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<DecisionAppeal>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={status === 'pending' ? 'Nothing to decide' : 'No appeal'}
            columns={[
              {
                key: 'r',
                header: 'Appeal',
                cell: (a) => (
                  <Link className="table__link" href={`/appeals/${a.id}`}>
                    {a.reference}
                  </Link>
                ),
              },
              { key: 'k', header: 'Of', cell: (a) => KIND_TEXT[a.kind] },
              { key: 'u', header: 'Unit', cell: (a) => <span className="t-mono">{a.unitCode}</span> },
              {
                key: 'l',
                header: 'Lodged',
                cell: (a) => <span title={formatDateTime(a.lodgedAt)}>{relativeTime(a.lodgedAt)}</span>,
              },
              { key: 's', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              {
                key: 'e',
                header: 'Effect',
                cell: (a) =>
                  a.decision?.effect === 'follow_up' && !a.decision.followedUpAt ? (
                    <strong>{EFFECT_TEXT.follow_up}</strong>
                  ) : a.decision ? (
                    EFFECT_TEXT[a.decision.effect]
                  ) : a.ownDecision ? (
                    'Your decision: another manager decides'
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
