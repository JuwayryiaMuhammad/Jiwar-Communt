'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { downloadPost } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import type { LogSearchResult } from '@/lib/queries';
import ar from '@/messages/ar/gate-reports';
import en from '@/messages/en/gate-reports';

type Hit = LogSearchResult['entries'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The gate log search (ADR 0056, page ADR 0079): the compound's days (31 at
 * most), a unit, a visitor named exactly — never a part of a name. The
 * name travels in the request's body only and is kept nowhere; every
 * search and export is recorded without it, 20 a 10 minutes.
 */
export default function GateLogSearchPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        <PageHeader title={t('search.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('search.title')}
        description={t('search.description')}
        actions={
          <Button
            onClick={() => {
              setCsvError(null);
              downloadPost('/api/v1/staff/gate/log-search/export', body(), `gate-log-${from}-${to}.csv`).catch(setCsvError);
            }}
          >
            {t('exportCsv')}
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
        <Field label={c('from')} error={fieldError(search.error, 'from')}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <Field label={c('to')} error={fieldError(search.error, 'to')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field label={c('unit')}>
          {(p) => <UnitPicker {...p} placeholder={t('anyUnit')} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
        </Field>
        <Field label={t('visitorName')} error={fieldError(search.error, 'visitorName')}>
          {(p) => <Input {...p} autoComplete="off" value={visitorName} onChange={(e) => setVisitorName(e.target.value)} />}
        </Field>
        <span style={{ alignSelf: 'end' }}>
          <Button type="submit" variant="primary" loading={search.isPending}>
            {c('search')}
          </Button>
        </span>
      </form>
      <ErrorAlert error={search.error} />
      {found ? (
        <>
          {found.truncated ? <Alert tone="warn">{t('truncated')}</Alert> : null}
          <Card flush>
            <DataTable<Hit>
              rows={found.entries}
              rowKey={(e) => e.id}
              empty={t('search.empty')}
              columns={[
                { key: 'at', header: t('col.when'), width: 170, cell: (e) => f.dateTime(e.occurredAt) },
                { key: 'gate', header: t('col.gate'), cell: (e) => e.gate.name },
                {
                  key: 'direction',
                  header: t('col.way'),
                  cell: (e) => <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? t('in') : t('out')}</Badge>,
                },
                { key: 'who', header: t('col.who'), cell: (e) => label(e.subjectType) },
                { key: 'unit', header: c('unit'), cell: (e) => e.unitCode },
                {
                  key: 'method',
                  header: t('col.how'),
                  cell: (e) => (e.unconfirmed ? t('methodUnconfirmed', { method: label(e.method) }) : label(e.method)),
                },
              ]}
            />
          </Card>
        </>
      ) : null}
    </>
  );
}
