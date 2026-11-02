'use client';

import { fieldError, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { downloadPost } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import type { LogSearchResult } from '@/lib/queries';

type Hit = LogSearchResult['entries'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The gate log search (ADR 0056, page ADR 0079): the compound's days (31 at
 * most), a unit, a visitor named exactly — never a part of a name. The
 * name travels in the request's body only and is kept nowhere; every
 * search and export is recorded without it, 20 a 10 minutes.
 */
export default function GateLogSearchPage() {
  const { ready, can } = usePermissions();
  const allowed = can('gate_log.search');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date()));
  const [unitId, setUnitId] = useState('');
  const [visitorName, setVisitorName] = useState('');
  const [found, setFound] = useState<LogSearchResult | null>(null);
  const [csvError, setCsvError] = useState<unknown>(null);
  const body = () => ({
    from,
    to,
    ...(unitId ? { unitId } : {}),
    ...(visitorName.trim() ? { visitorName: visitorName.trim() } : {}),
  });
  const search = useAction(() => unwrap(api.POST('/api/v1/staff/gate/log-search', { body: body() })), {
    onDone: (r) => setFound(r),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Gate log search" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Gate log search"
        description="Who came in and out, by day, unit, or a visitor’s full name exactly as written. Names are kept 30 days. Every search is recorded, without the name."
        actions={
          <Button
            onClick={() => {
              setCsvError(null);
              downloadPost('/api/v1/staff/gate/log-search/export', body(), `gate-log-${from}-${to}.csv`).catch(setCsvError);
            }}
          >
            Export CSV
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <form
        className="form__row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          search.mutate();
        }}
      >
        <Field label="From" error={fieldError(search.error, 'from')}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <Field label="To" error={fieldError(search.error, 'to')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field label="Unit">
          {(p) => <UnitPicker {...p} placeholder="Any unit" value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
        </Field>
        <Field label="Visitor’s full name" error={fieldError(search.error, 'visitorName')}>
          {(p) => <Input {...p} autoComplete="off" value={visitorName} onChange={(e) => setVisitorName(e.target.value)} />}
        </Field>
        <span style={{ alignSelf: 'end' }}>
          <Button type="submit" variant="primary" loading={search.isPending}>
            Search
          </Button>
        </span>
      </form>
      <ErrorAlert error={search.error} />
      {found ? (
        <>
          {found.truncated ? <Alert tone="warn">Only the newest 200 entries are shown: narrow the days or export them.</Alert> : null}
          <Card flush>
            <DataTable<Hit>
              rows={found.entries}
              rowKey={(e) => e.id}
              empty="No entry matches"
              columns={[
                { key: 'at', header: 'When', width: 170, cell: (e) => formatDateTime(e.occurredAt) },
                { key: 'gate', header: 'Gate', cell: (e) => e.gate.name },
                {
                  key: 'direction',
                  header: 'Way',
                  cell: (e) => <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? 'In' : 'Out'}</Badge>,
                },
                { key: 'who', header: 'Who', cell: (e) => humanize(e.subjectType) },
                { key: 'unit', header: 'Unit', cell: (e) => e.unitCode },
                { key: 'method', header: 'How', cell: (e) => humanize(e.method) + (e.unconfirmed ? ' · unconfirmed' : '') },
              ]}
            />
          </Card>
        </>
      ) : null}
    </>
  );
}
