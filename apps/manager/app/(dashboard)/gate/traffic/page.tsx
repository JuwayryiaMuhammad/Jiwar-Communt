'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, Stat, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TrafficReport } from '@/lib/queries';
import ar from '@/messages/ar/gate-reports';
import en from '@/messages/en/gate-reports';

type Row = TrafficReport['rows'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The gate's traffic (ADR 0056, page ADR 0079): per day and gate, the
 * visitors by how they came in, the service vehicles by kind, and the
 * resident vehicles counted. Counts only: never a name, a unit or a plate.
 */
export default function GateTrafficPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('gate.read');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 6 * 24 * 3_600_000)));
  const [gateId, setGateId] = useState('');
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates, enabled: allowed });
  const report = useQuery({ queryKey: keys.traffic(from, to, gateId), queryFn: () => fetchers.traffic(from, to, gateId), enabled: allowed });
  const [csvError, setCsvError] = useState<unknown>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('traffic.title')} />
        <ForbiddenState />
      </>
    );
  const totals = report.data?.totals;
  return (
    <>
      <PageHeader
        title={t('traffic.title')}
        description={t('traffic.description')}
        actions={
          <Button
            onClick={() =>
              download('/api/v1/staff/gate/reports/traffic/export', { from, to, gateId: gateId || undefined }, `gate-traffic-${from}-${to}.csv`).catch(
                setCsvError,
              )
            }
          >
            {t('exportCsv')}
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={t('col.gate')}>
          {(p) => (
            <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">{t('everyGate')}</option>
              {(gates.data?.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <QueryState query={report}>
        {totals ? (
          <div className="grid grid--stats">
            <Stat
              label={t('visitors')}
              value={f.number(totals.visitors.visitorPass + totals.visitors.gateRequest + totals.visitors.fieldException)}
              hint={t('visitorsHint', {
                pass: f.number(totals.visitors.visitorPass),
                request: f.number(totals.visitors.gateRequest),
                exception: f.number(totals.visitors.fieldException),
              })}
            />
            <Stat
              label={t('serviceVehicles')}
              value={f.number(totals.serviceVehicles.tanker + totals.serviceVehicles.waste + totals.serviceVehicles.delivery + totals.serviceVehicles.other)}
              hint={t('serviceHint', {
                tanker: totals.serviceVehicles.tanker,
                waste: f.number(totals.serviceVehicles.waste),
                delivery: totals.serviceVehicles.delivery,
              })}
            />
            <Stat label={t('residentVehicles')} value={f.number(totals.residentVehicles.in)} hint={t('residentHint', { out: f.number(totals.residentVehicles.out) })} />
          </div>
        ) : null}
        <Card flush>
          <DataTable<Row>
            rows={report.data?.rows ?? []}
            rowKey={(r) => `${r.date}:${r.gate.id}`}
            empty={t('traffic.empty')}
            columns={[
              { key: 'date', header: t('col.day'), width: 120, cell: (r) => f.day(r.date) },
              { key: 'gate', header: t('col.gate'), cell: (r) => r.gate.name },
              { key: 'pass', header: t('col.byPass'), cell: (r) => f.number(r.visitors.visitorPass) },
              { key: 'request', header: t('col.askedAtGate'), cell: (r) => f.number(r.visitors.gateRequest) },
              { key: 'exception', header: t('col.byException'), cell: (r) => f.number(r.visitors.fieldException) },
              {
                key: 'service',
                header: t('serviceVehicles'),
                cell: (r) => f.number(r.serviceVehicles.tanker + r.serviceVehicles.waste + r.serviceVehicles.delivery + r.serviceVehicles.other),
              },
              { key: 'in', header: t('col.residentsIn'), cell: (r) => f.number(r.residentVehicles.in) },
              { key: 'out', header: t('col.residentsOut'), cell: (r) => f.number(r.residentVehicles.out) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
