'use client';

import { shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, PageHeader, Select, useCommonT } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { useTenantNames } from '@/components/tenant-names';
import { PLATFORM_ACTIONS, useCodeLabel } from '@/lib/labels';
import { keys, listAudit, type AuditEntry } from '@/lib/queries';
import ar from '@/messages/ar/logs';
import en from '@/messages/en/logs';

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
            <bdi dir="ltr">{text}</bdi>
          </Badge>
        );
      })}
    </span>
  );
}

export default function PlatformAuditPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useCodeLabel();
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
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <div className="toolbar">
        <Field label={t('audit.filter')}>
          {(p) => (
            <Select {...p} value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
              <option value="">{t('audit.all')}</option>
              {PLATFORM_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {label(a)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('filter.compound')}>
          {(p) => (
            <Select
              {...p}
              value={filters.targetTenantId}
              onChange={(e) => setFilters({ ...filters, targetTenantId: e.target.value })}
            >
              <option value="">{t('filter.allCompounds')}</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40 }}>
            {t('filter.reset')}
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={audit}>
          <DataTable<AuditEntry>
            rows={audit.rows}
            rowKey={(a) => a.id}
            empty={dirty ? t('audit.emptyMatch') : t('audit.empty')}
            columns={[
              {
                key: 'time',
                header: t('col.when'),
                cell: (a) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(a.occurredAt)}</span>,
              },
              { key: 'action', header: t('audit.col.action'), cell: (a) => <span className="table__primary">{label(a.action)}</span> },
              {
                key: 'actor',
                header: c('by'),
                cell: (a) => (
                  <span title={a.actorId ?? ''}>
                    {label(a.actorType)}
                    {a.actorId ? <span className="t-mono t-secondary"> {shortId(a.actorId)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'tenant',
                header: t('col.compound'),
                cell: (a) =>
                  a.targetTenantId ? (
                    <Link className="table__link" href={`/tenants/${a.targetTenantId}`}>
                      {names.get(a.targetTenantId) ?? shortId(a.targetTenantId)}
                    </Link>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
              { key: 'changes', header: t('audit.col.changes'), cell: (a) => <Changes value={a.changes} /> },
            ]}
          />
          <LoadMore query={audit} />
        </QueryState>
      </Card>
    </>
  );
}
