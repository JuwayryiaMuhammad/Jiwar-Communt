'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { CompensationDecision } from '@/components/experience/compensation-decision';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Compensation } from '@/lib/queries';

type Status = 'proposed' | 'approved' | 'rejected' | '';

/**
 * The compensations (ADR 0082), the oldest first: who decides each now (the
 * manager, or the board above its binding limit), decided here once.
 */
export default function CompensationsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const [status, setStatus] = useState<Status>('proposed');
  const list = useCursorList(keys.compensations({ status }), (c) => fetchers.compensations({ status }, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Compensations" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Compensations"
        description="Proposed on a case and decided once by the manager. A credit goes through finance; above the board’s binding limit it waits for the board."
      />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="">Any status</option>
              <option value="proposed">Waiting</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Compensation>
            rows={list.rows}
            rowKey={(x) => x.id}
            empty="No compensation matches"
            columns={[
              { key: 'at', header: 'Proposed', width: 170, cell: (x) => formatDateTime(x.proposedAt) },
              {
                key: 'case',
                header: 'Case',
                cell: (x) => (
                  <Link className="table__link" href={`/experience/cases/${x.caseId}`}>
                    Open case
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (x) => `${humanize(x.kind)}${x.amount ? ` · ${x.amount} EGP` : ''}` },
              { key: 'who', header: 'Decides', cell: (x) => (x.authority ? humanize(x.authority.decider) : '—') },
              { key: 'status', header: 'Status', cell: (x) => <Badge>{humanize(x.rejectReason ?? x.status)}</Badge> },
              { key: 'decide', header: '', cell: (x) => (can('experience.compensate') ? <CompensationDecision compensation={x} unitId={x.unitId} /> : null) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
