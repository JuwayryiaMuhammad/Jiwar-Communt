'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceCase } from '@/lib/queries';

/**
 * Community cases (ADR 0081): one problem many households of a building
 * report, opened by itself at the compound’s threshold.
 */
export default function CasesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [status, setStatus] = useState<MaintenanceCase['status'] | ''>('open');
  const list = useCursorList(keys.cases(status), (c) => fetchers.cases(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Community cases" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Community cases"
        description="A case opens when a building’s residents report one kind of fault often enough within the window (Maintenance setup → SLA → Analytics). Its tickets keep their own course."
      />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as MaintenanceCase['status'] | '')}>
              <option value="">Any status</option>
              {(['open', 'resolved', 'dismissed'] as const).map((x) => (
                <option key={x} value={x}>
                  {humanize(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<MaintenanceCase>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty="No case"
            columns={[
              {
                key: 'opened',
                header: 'Opened',
                width: 170,
                cell: (c) => (
                  <Link className="table__link" href={`/cases/${c.id}`}>
                    {formatDateTime(c.openedAt)}
                  </Link>
                ),
              },
              { key: 'building', header: 'Building', cell: (c) => c.buildingName ?? '—' },
              { key: 'category', header: 'Category', cell: (c) => humanize(c.categoryKey) },
              { key: 'tickets', header: 'Tickets', cell: (c) => c.ticketCount },
              { key: 'order', header: 'Work order', cell: (c) => c.workOrder?.number ?? '—' },
              { key: 'status', header: 'Status', cell: (c) => <Badge>{humanize(c.status)}</Badge> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
