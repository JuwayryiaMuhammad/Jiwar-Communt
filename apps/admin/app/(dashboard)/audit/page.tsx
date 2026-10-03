'use client';

import { formatDateTime, humanize, shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, PageHeader, Select } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { useTenantNames } from '@/components/tenant-names';
import { PLATFORM_ACTIONS } from '@/lib/labels';
import { keys, listAudit, type AuditEntry } from '@/lib/queries';

const EMPTY = { action: '', targetTenantId: '', from: '', to: '' };

function show(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Personal values arrive as `{ changed: true }` (ADR 0014); show field names only for those. */
function Changes({ value }: { value: AuditEntry['changes'] }) {
  if (!value || !Object.keys(value).length) return <span className="t-secondary">—</span>;
  return (
    <span className="chip-list">
      {Object.entries(value).map(([field, change]) => {
        const c = change as { from?: unknown; to?: unknown; changed?: boolean } | null;
        const text =
          c && typeof c === 'object' && 'to' in c
            ? `${field}: ${show(c.from)} → ${show(c.to)}`
            : field;
        return (
          <Badge key={field} tone="beige" plain>
            {text}
          </Badge>
        );
      })}
    </span>
  );
}

export default function PlatformAuditPage() {
  const [filters, setFilters] = useState(EMPTY);
  const { names, tenants } = useTenantNames();
  const query = {
    action: filters.action,
    targetTenantId: filters.targetTenantId,
    from: startOfDay(filters.from),
    to: endOfDay(filters.to),
  };
  const audit = useCursorList(keys.audit(query), (cursor) => listAudit(query, cursor, 50));
  const dirty = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every platform action, append-only. Entries can't be edited or deleted, and they never hold personal data."
      />
      <div className="toolbar">
        <Field label="Action">
          {(p) => (
            <Select {...p} value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
              <option value="">All actions</option>
              {PLATFORM_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {humanize(a)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Compound">
          {(p) => (
            <Select
              {...p}
              value={filters.targetTenantId}
              onChange={(e) => setFilters({ ...filters, targetTenantId: e.target.value })}
            >
              <option value="">All compounds</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40 }}>
            Reset
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={audit}>
          <DataTable<AuditEntry>
            rows={audit.rows}
            rowKey={(a) => a.id}
            empty={dirty ? 'No entry matches these filters' : 'No platform actions yet'}
            columns={[
              {
                key: 'time',
                header: 'When',
                cell: (a) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.occurredAt)}</span>,
              },
              { key: 'action', header: 'Action', cell: (a) => <span className="table__primary">{humanize(a.action)}</span> },
              {
                key: 'actor',
                header: 'By',
                cell: (a) => (
                  <span title={a.actorId ?? ''}>
                    {humanize(a.actorType)}
                    {a.actorId ? <span className="t-mono t-secondary"> {shortId(a.actorId)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'tenant',
                header: 'Compound',
                cell: (a) =>
                  a.targetTenantId ? (
                    <Link className="table__link" href={`/tenants/${a.targetTenantId}`}>
                      {names.get(a.targetTenantId) ?? shortId(a.targetTenantId)}
                    </Link>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
              { key: 'changes', header: 'Changes', cell: (a) => <Changes value={a.changes} /> },
            ]}
          />
          <LoadMore query={audit} />
        </QueryState>
      </Card>
    </>
  );
}
