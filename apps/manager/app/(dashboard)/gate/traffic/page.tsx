'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TrafficReport } from '@/lib/queries';

type Row = TrafficReport['rows'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The gate's traffic (ADR 0056, page ADR 0079): per day and gate, the
 * visitors by how they came in, the service vehicles by kind, and the
 * resident vehicles counted. Counts only: never a name, a unit or a plate.
 */
export default function GateTrafficPage() {
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
        <PageHeader title="Gate traffic" />
        <ForbiddenState />
      </>
    );
  const t = report.data?.totals;
  return (
    <>
      <PageHeader
        title="Gate traffic"
        description="Who came in, day by day and gate by gate: visitors by how they came, service vehicles by kind, resident vehicles in and out. 31 days at most."
        actions={
          <Button
            onClick={() =>
              download('/api/v1/staff/gate/reports/traffic/export', { from, to, gateId: gateId || undefined }, `gate-traffic-${from}-${to}.csv`).catch(
                setCsvError,
              )
            }
          >
            Export CSV
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Gate">
          {(p) => (
            <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">Every gate</option>
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
        {t ? (
          <div className="grid grid--stats">
            <Stat label="Visitors" value={t.visitors.visitorPass + t.visitors.gateRequest + t.visitors.fieldException} hint={`${t.visitors.visitorPass} by pass · ${t.visitors.gateRequest} asked at the gate · ${t.visitors.fieldException} by exception`} />
            <Stat
              label="Service vehicles"
              value={t.serviceVehicles.tanker + t.serviceVehicles.waste + t.serviceVehicles.delivery + t.serviceVehicles.other}
              hint={`${t.serviceVehicles.tanker} tankers · ${t.serviceVehicles.waste} waste · ${t.serviceVehicles.delivery} deliveries`}
            />
            <Stat label="Resident vehicles" value={t.residentVehicles.in} hint={`${t.residentVehicles.out} out`} />
          </div>
        ) : null}
        <Card flush>
          <DataTable<Row>
            rows={report.data?.rows ?? []}
            rowKey={(r) => `${r.date}:${r.gate.id}`}
            empty="No gate in this period"
            columns={[
              { key: 'date', header: 'Day', width: 120, cell: (r) => r.date },
              { key: 'gate', header: 'Gate', cell: (r) => r.gate.name },
              { key: 'pass', header: 'By pass', cell: (r) => r.visitors.visitorPass },
              { key: 'request', header: 'Asked at the gate', cell: (r) => r.visitors.gateRequest },
              { key: 'exception', header: 'By exception', cell: (r) => r.visitors.fieldException },
              {
                key: 'service',
                header: 'Service vehicles',
                cell: (r) => r.serviceVehicles.tanker + r.serviceVehicles.waste + r.serviceVehicles.delivery + r.serviceVehicles.other,
              },
              { key: 'in', header: 'Residents in', cell: (r) => r.residentVehicles.in },
              { key: 'out', header: 'Residents out', cell: (r) => r.residentVehicles.out },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
