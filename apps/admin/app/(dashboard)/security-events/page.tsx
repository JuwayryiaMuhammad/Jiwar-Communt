'use client';

import { formatDateTime, shortId } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, PageHeader, Select } from '@jiwar/ui';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { useTenantNames } from '@/components/tenant-names';
import { eventTone, SECURITY_EVENTS } from '@/lib/labels';
import { keys, listEvents, type SecurityEvent } from '@/lib/queries';

const EMPTY = { event: '', tenantId: '', from: '', to: '' };

function Metadata({ value }: { value: SecurityEvent['metadata'] }) {
  if (!value || !Object.keys(value).length) return <span className="t-secondary">—</span>;
  return (
    <span className="t-mono t-secondary">
      {Object.entries(value)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' · ')}
    </span>
  );
}

export default function SecurityEventsPage() {
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
      <PageHeader
        title="Security events"
        description="Sign-ins, verification codes and sessions across every compound. Identifiers are stored as hashes, never as emails or phones."
      />
      <div className="toolbar">
        <Field label="Event">
          {(p) => (
            <Select {...p} value={filters.event} onChange={(e) => setFilters({ ...filters, event: e.target.value })}>
              <option value="">All events</option>
              {SECURITY_EVENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Compound">
          {(p) => (
            <Select {...p} value={filters.tenantId} onChange={(e) => setFilters({ ...filters, tenantId: e.target.value })}>
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
        <QueryState query={events}>
          <DataTable<SecurityEvent>
            rows={events.rows}
            rowKey={(e) => e.id}
            empty={dirty ? 'No event matches these filters' : 'No security events yet'}
            columns={[
              {
                key: 'time',
                header: 'When',
                cell: (e) => <span className="t-num" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.occurredAt)}</span>,
              },
              { key: 'event', header: 'Event', cell: (e) => <Badge tone={eventTone(e.event)}>{e.event}</Badge> },
              {
                key: 'tenant',
                header: 'Compound',
                cell: (e) =>
                  e.tenantId ? (
                    <Link className="table__link" href={`/tenants/${e.tenantId}`}>
                      {names.get(e.tenantId) ?? shortId(e.tenantId)}
                    </Link>
                  ) : e.platformAdminId ? (
                    <Badge tone="dark" plain>
                      Platform
                    </Badge>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
              {
                key: 'subject',
                header: 'Subject',
                cell: (e) => (
                  <span className="t-mono t-secondary" title={e.accountId ?? e.platformAdminId ?? e.identifierHash ?? ''}>
                    {e.accountId
                      ? `account ${shortId(e.accountId)}`
                      : e.platformAdminId
                        ? `admin ${shortId(e.platformAdminId)}`
                        : e.identifierHash
                          ? `id# ${shortId(e.identifierHash)}`
                          : '—'}
                  </span>
                ),
              },
              { key: 'ip', header: 'IP', cell: (e) => <span className="t-mono">{e.ip ?? '—'}</span> },
              { key: 'meta', header: 'Details', cell: (e) => <Metadata value={e.metadata} /> },
            ]}
          />
          <LoadMore query={events} />
        </QueryState>
      </Card>
    </>
  );
}
