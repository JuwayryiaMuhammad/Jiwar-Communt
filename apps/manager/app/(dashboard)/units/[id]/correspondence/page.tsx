'use client';

import { unwrap } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, ForbiddenState, PageHeader, Select, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/units-correspondence';
import en from '@/messages/en/units-correspondence';

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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Select aria-label={c('kind')} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t('everything')}</option>
          {TYPES.map((v) => (
            <option key={v} value={v}>
              {label(v)}
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
              { key: 'when', header: t('col.when'), cell: (r) => fmt.dateTime(r.at) },
              { key: 'what', header: t('col.what'), cell: (r) => label(r.type) },
              { key: 'reference', header: t('col.reference'), cell: (r) => r.number ?? '—' },
              { key: 'kind', header: c('kind'), cell: (r) => (r.kind ? label(r.kind) : '—') },
              { key: 'status', header: c('status'), cell: (r) => (r.status ? label(r.status) : '—') },
              { key: 'direction', header: '', cell: (r) => <Badge>{r.direction === 'from_unit' ? t('fromUnit') : t('toUnit')}</Badge> },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
