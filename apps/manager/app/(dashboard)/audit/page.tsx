'use client';

import { shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, Input, PageHeader, useLabel } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { fetchers, keys, type AuditEntry } from '@/lib/queries';
import ar from '@/messages/ar/audit-log';
import en from '@/messages/en/audit-log';

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
            <span className="ltr">{c && typeof c === 'object' && 'to' in c ? `${field}: ${show(c.from)} → ${show(c.to)}` : field}</span>
          </Badge>
        );
      })}
    </span>
  );
}

export default function AuditPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
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
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Field label={t('action')} hint={t('actionHint')}>
          {(p) => <Input {...p} value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />}
        </Field>
        <Field label={t('targetType')} hint={t('targetTypeHint')}>
          {(p) => <Input {...p} value={filters.targetType} onChange={(e) => setFilters({ ...filters, targetType: e.target.value })} />}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40, alignSelf: 'center' }}>
            {t('reset')}
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AuditEntry>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={dirty ? t('emptyFiltered') : t('empty')}
            columns={[
              {
                key: 'when',
                header: t('when'),
                cell: (a) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{f.dateTime(a.occurredAt)}</span>,
              },
              {
                key: 'action',
                header: t('action'),
                cell: (a) => (
                  <div>
                    <div className="table__primary">{label(a.action)}</div>
                    <div className="t-mono t-secondary ltr">{a.action}</div>
                  </div>
                ),
              },
              {
                key: 'actor',
                header: t('by'),
                cell: (a) => (
                  <span title={a.actorId ?? ''}>
                    {label(a.actorType)}
                    {a.actorId ? <span className="t-mono t-secondary"> {shortId(a.actorId)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'target',
                header: t('target'),
                cell: (a) => (
                  <span>
                    {label(a.targetType)}
                    {a.targetId ? <span className="t-mono t-secondary"> {shortId(a.targetId)}</span> : null}
                  </span>
                ),
              },
              { key: 'changes', header: t('changes'), cell: (a) => <Changes value={a.changes} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
