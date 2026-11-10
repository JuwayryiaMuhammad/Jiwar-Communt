'use client';

import { shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, PageHeader, Select, useCommonT } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { EventBadge } from '@/components/event-badge';
import { useTenantNames } from '@/components/tenant-names';
import { SECURITY_EVENTS, useCodeLabel } from '@/lib/labels';
import { keys, listEvents, type SecurityEvent } from '@/lib/queries';
import ar from '@/messages/ar/logs';
import en from '@/messages/en/logs';

const EMPTY = { event: '', tenantId: '', from: '', to: '' };

function Metadata({ value }: { value: SecurityEvent['metadata'] }) {
  if (!value || !Object.keys(value).length) return <span className="t-secondary">—</span>;
  return (
    <bdi className="t-mono t-secondary">
      {Object.entries(value)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' · ')}
    </bdi>
  );
}

export default function SecurityEventsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useCodeLabel();
  const [filters, setFilters] = useState(EMPTY);
  const { names, tenants } = useTenantNames();
  const query = {
    event: filters.event,
    tenantId: filters.tenantId,
    from: startOfDay(filters.from),
    to: endOfDay(filters.to),
  };
  const events = useCursorList(keys.events(query), (cursor) => listEvents(query, cursor, 50), {
    refetchInterval: 60_000,
  });
  const dirty = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader title={t('events.title')} description={t('events.description')} />
      <div className="toolbar">
        <Field label={t('events.filter')}>
          {(p) => (
            <Select {...p} value={filters.event} onChange={(e) => setFilters({ ...filters, event: e.target.value })}>
              <option value="">{t('events.all')}</option>
              {SECURITY_EVENTS.map((e) => (
                <option key={e} value={e}>
                  {label(e)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('filter.compound')}>
          {(p) => (
            <Select {...p} value={filters.tenantId} onChange={(e) => setFilters({ ...filters, tenantId: e.target.value })}>
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
        <QueryState query={events}>
          <DataTable<SecurityEvent>
            rows={events.rows}
            rowKey={(e) => e.id}
            empty={dirty ? t('events.emptyMatch') : t('events.empty')}
            columns={[
              {
                key: 'time',
                header: t('col.when'),
                cell: (e) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(e.occurredAt)}</span>,
              },
              {
                key: 'event',
                header: t('events.col.event'),
                cell: (e) => <EventBadge event={e.event} />,
              },
              {
                key: 'tenant',
                header: t('col.compound'),
                cell: (e) =>
                  e.tenantId ? (
                    <Link className="table__link" href={`/tenants/${e.tenantId}`}>
                      {names.get(e.tenantId) ?? shortId(e.tenantId)}
                    </Link>
                  ) : e.platformAdminId ? (
                    <Badge tone="dark" plain>
                      {t('events.platform')}
                    </Badge>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
              {
                key: 'subject',
                header: t('events.col.subject'),
                cell: (e) => (
                  <span className="t-mono t-secondary" title={e.accountId ?? e.platformAdminId ?? e.identifierHash ?? ''}>
                    {e.accountId
                      ? t('subject.account', { id: shortId(e.accountId) })
                      : e.platformAdminId
                        ? t('subject.admin', { id: shortId(e.platformAdminId) })
                        : e.identifierHash
                          ? t('subject.hash', { id: shortId(e.identifierHash) })
                          : '—'}
                  </span>
                ),
              },
              { key: 'ip', header: t('events.col.ip'), cell: (e) => <span className="t-mono">{e.ip ?? '—'}</span> },
              { key: 'meta', header: c('details'), cell: (e) => <Metadata value={e.metadata} /> },
            ]}
          />
          <LoadMore query={events} />
        </QueryState>
      </Card>
    </>
  );
}
