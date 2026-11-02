'use client';

import { formatDate, formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { RecordEntryDialog } from '@/components/security/unit-entry-dialogs';
import { api } from '@/lib/api';

type ClosedUnit = Schema<'ClosedUnitView'>;
const KEY = ['closed-units'] as const;

/**
 * The units in closed mode (ADR 0083): since when, their last inspection,
 * an owner's open request, their proxies, and their round. A round falls
 * due every N days (the gate settings) after the unit closed or was last
 * inspected: schedule it as a guard's inspection. An emergency entry is
 * recorded from here too.
 */
export default function ClosedUnitsPage() {
  const [scheduling, setScheduling] = useState<ClosedUnit | null>(null);
  const [entering, setEntering] = useState<ClosedUnit | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/security/closed-units')),
    refetchInterval: 300_000,
  });
  return (
    <>
      <PageHeader
        title="Closed units"
        description="Units their owners closed, the longest closed first. A round falls due every few days; schedule it as an inspection."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<ClosedUnit>
            rows={list.data?.data}
            rowKey={(u) => u.unitId}
            empty="No closed unit"
            emptyHint="An owner closes a unit from the app while away."
            columns={[
              {
                key: 'unit',
                header: 'Unit',
                cell: (u) => (
                  <span>
                    <strong>{u.unitCode}</strong>
                    {u.building ? <span className="t-secondary"> · {u.building}</span> : null}
                  </span>
                ),
              },
              { key: 'since', header: 'Closed since', cell: (u) => formatDate(u.closedSince) },
              {
                key: 'last',
                header: 'Last inspection',
                cell: (u) =>
                  u.lastInspection ? (
                    <span>
                      {formatDateTime(u.lastInspection.doneAt)}{' '}
                      <Badge tone={u.lastInspection.outcome === 'issue_found' ? 'terracotta' : 'green'}>
                        {u.lastInspection.outcome.replace(/_/g, ' ')}
                      </Badge>
                    </span>
                  ) : (
                    <span className="t-secondary">None yet</span>
                  ),
              },
              {
                key: 'request',
                header: 'Owner’s request',
                cell: (u) =>
                  u.openRequest ? (
                    <Link className="table__link" href="/security/inspection-requests">
                      {u.openRequest.reference} ({u.openRequest.status})
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'proxies', header: 'Proxies', cell: (u) => String(u.liveProxies) },
              {
                key: 'round',
                header: 'Round',
                cell: (u) =>
                  u.round ? (
                    <Badge tone={u.round.status === 'due' ? 'terracotta' : 'beige'}>
                      {u.round.status === 'due' ? `Due since ${formatDate(u.round.dueOn)}` : 'Scheduled'}
                    </Badge>
                  ) : (
                    <span className="t-secondary">Next {formatDate(u.nextRoundOn)}</span>
                  ),
              },
              {
                key: 'act',
                header: '',
                cell: (u) => (
                  <span style={{ display: 'flex', gap: 8 }}>
                    {u.round?.status === 'due' ? (
                      <Button size="sm" variant="primary" onClick={() => setScheduling(u)}>
                        Schedule
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setEntering(u)}>
                      Emergency entry
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {scheduling?.round ? (
        <NewTaskDialog
          round={{ id: scheduling.round.id, unitId: scheduling.unitId, unitCode: scheduling.unitCode }}
          onClose={() => setScheduling(null)}
        />
      ) : null}
      {entering ? (
        <RecordEntryDialog
          unit={{ id: entering.unitId, code: entering.unitCode }}
          onClose={() => setEntering(null)}
        />
      ) : null}
    </>
  );
}
