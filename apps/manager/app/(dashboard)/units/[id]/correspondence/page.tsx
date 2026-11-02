'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

interface Row {
  type: string;
  id: string;
  number: string | null;
  kind: string | null;
  status: string | null;
  direction: 'from_unit' | 'to_unit';
  at: string;
}

const TYPES = ['management_request', 'official_letter', 'announcement', 'neighbour_complaint', 'formal_notice', 'ticket'] as const;

/**
 * A unit's correspondence (ADR 0080): one timeline over what its people and
 * the management wrote each other. Codes and references only; each read is
 * logged in the audit trail.
 */
export default function UnitCorrespondencePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const [type, setType] = useState('');
  const rows = useQuery({
    queryKey: ['unit', id, 'correspondence', type],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/correspondence', {
          params: { path: { unitId: id }, query: { limit: 100, ...(type ? { type: type as (typeof TYPES)[number] } : {}) } },
        }),
      ) as Promise<{ data: Row[] }>,
    enabled: can('correspondence.read'),
  });
  if (!can('correspondence.read')) return <ForbiddenState />;
  return (
    <>
      <PageHeader title="Correspondence" description="Everything the unit’s people and the management wrote each other, newest first. Opening this page is recorded in the audit trail." />
      <div className="toolbar">
        <Select aria-label="Kind" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Everything</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </Select>
      </div>
      <Card flush>
        <QueryState query={rows}>
          <DataTable
            rows={rows.data?.data ?? []}
            rowKey={(r) => `${r.type}:${r.id}`}
            columns={[
              { key: 'when', header: 'When', cell: (r) => formatDateTime(r.at) },
              { key: 'what', header: 'What', cell: (r) => humanize(r.type) },
              { key: 'reference', header: 'Reference', cell: (r) => r.number ?? '—' },
              { key: 'kind', header: 'Kind', cell: (r) => (r.kind ? humanize(r.kind) : '—') },
              { key: 'status', header: 'Status', cell: (r) => (r.status ? humanize(r.status) : '—') },
              { key: 'direction', header: '', cell: (r) => <Badge>{r.direction === 'from_unit' ? 'From the unit' : 'To the unit'}</Badge> },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
