'use client';

import { formatDateTime, humanize, shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, Input, PageHeader } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { fetchers, keys, type AuditEntry } from '@/lib/queries';

const EMPTY = { action: '', targetType: '', from: '', to: '' };

function show(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Personal values arrive as `{ changed: true }` (ADR 0014): only the field name is shown. */
function Changes({ value }: { value: AuditEntry['changes'] }) {
  if (!value || !Object.keys(value).length) return <span className="t-secondary">—</span>;
  return (
    <span className="chip-list">
      {Object.entries(value).map(([field, change]) => {
        const c = change as { from?: unknown; to?: unknown } | null;
        return (
          <Badge key={field} tone="beige" plain>
            {c && typeof c === 'object' && 'to' in c ? `${field}: ${show(c.from)} → ${show(c.to)}` : field}
          </Badge>
        );
      })}
    </span>
  );
}

export default function AuditPage() {
  const [filters, setFilters] = useState(EMPTY);
  const typed = useDeferredValue(filters);
  const query = {
    action: typed.action.trim(),
    targetType: typed.targetType.trim(),
    from: startOfDay(typed.from),
    to: endOfDay(typed.to),
  };
  const list = useCursorList(keys.audit(query), (c) => fetchers.audit(query, c));
  const dirty = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change in the compound, append-only. Entries name people by id and never hold personal values."
      />
      <div className="toolbar">
        <Field label="Action" hint="Exact, e.g. resident.created">
          {(p) => <Input {...p} value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />}
        </Field>
        <Field label="Target type" hint="e.g. account, unit">
          {(p) => <Input {...p} value={filters.targetType} onChange={(e) => setFilters({ ...filters, targetType: e.target.value })} />}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40, alignSelf: 'center' }}>
            Reset
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AuditEntry>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={dirty ? 'No entry matches these filters' : 'Nothing recorded yet'}
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (a) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.occurredAt)}</span>,
              },
              {
                key: 'action',
                header: 'Action',
                cell: (a) => (
                  <div>
                    <div className="table__primary">{humanize(a.action)}</div>
                    <div className="t-mono t-secondary">{a.action}</div>
                  </div>
                ),
              },
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
                key: 'target',
                header: 'Target',
                cell: (a) => (
                  <span>
                    {humanize(a.targetType)}
                    {a.targetId ? <span className="t-mono t-secondary"> {shortId(a.targetId)}</span> : null}
                  </span>
                ),
              },
              { key: 'changes', header: 'Changes', cell: (a) => <Changes value={a.changes} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
