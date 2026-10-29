'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Stat,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Consumption, type MeterAlert, type Tariff } from '@/lib/queries';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
type Kind = (typeof KINDS)[number];
type GroupBy = 'building' | 'area' | 'meter';
const iso = (d: Date) => d.toISOString().slice(0, 10);

function TariffDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const toast = useToast();
  const [effectiveOn, setEffectiveOn] = useState(iso(new Date()));
  const [price, setPrice] = useState('');
  const add = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/energy/tariffs', { body: { kind, effectiveOn, pricePerUnit: price } })),
    {
      invalidate: [keys.energyAll],
      onDone: () => {
        toast.show('Tariff added.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`New ${humanize(kind).toLowerCase()} tariff`}
      description="Never edited: a later day’s tariff takes over."
      onSubmit={() => price && add.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!price}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={add.error} />
        <div className="form__row">
          <Field label="From" error={fieldError(add.error, 'effectiveOn')}>
            {(p) => <Input {...p} type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />}
          </Field>
          <Field label="EGP a unit" error={fieldError(add.error, 'pricePerUnit')}>
            {(p) => <Input {...p} value={price} onChange={(e) => setPrice(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function SpikeRule() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.energySettings, queryFn: fetchers.energySettings });
  const [factor, setFactor] = useState<string | null>(null);
  const [periods, setPeriods] = useState<string | null>(null);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/energy/settings', {
          body: {
            ...(factor !== null ? { anomalyFactor: factor } : {}),
            ...(periods !== null ? { anomalyPeriods: Number(periods) } : {}),
          },
        }),
      ),
    { invalidate: [keys.energySettings], onDone: () => toast.show('Saved.') },
  );
  const s = settings.data;
  return (
    <Card>
      <CardHeader title="Spike rule">
        <span className="text-muted">A period’s use a day above the mean of the periods before it, times the factor.</span>
      </CardHeader>
      <QueryState query={settings}>
        <CardBody>
          <div className="form">
            <ErrorAlert error={save.error} />
            <div className="form__row">
              <Field label="Factor" hint="1.2 to 10." error={fieldError(save.error, 'anomalyFactor')}>
                {(p) => <Input {...p} value={factor ?? s?.anomalyFactor ?? ''} onChange={(e) => setFactor(e.target.value)} />}
              </Field>
              <Field label="Periods in the mean" hint="3 to 24." error={fieldError(save.error, 'anomalyPeriods')}>
                {(p) => (
                  <Input {...p} type="number" min={3} max={24} value={periods ?? String(s?.anomalyPeriods ?? '')} onChange={(e) => setPeriods(e.target.value)} />
                )}
              </Field>
            </div>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={factor === null && periods === null} onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
          </div>
        </CardBody>
      </QueryState>
    </Card>
  );
}

/** Consumption, spikes and tariffs (ADR 0066), computed on read from the live readings. */
export default function EnergyPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const now = new Date();
  const [kind, setKind] = useState<Kind>('electricity');
  const [groupBy, setGroupBy] = useState<GroupBy>('building');
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)));
  const [to, setTo] = useState(iso(now));
  const [addingTariff, setAddingTariff] = useState(false);
  const q = { kind, groupBy, from, to };
  const report = useQuery({ queryKey: keys.consumption(q), queryFn: () => fetchers.consumption(q), enabled: can('energy.read') });
  const alerts = useQuery({
    queryKey: keys.meterAlerts({ open: 'true' }),
    queryFn: () => fetchers.meterAlerts({ open: 'true' }),
    enabled: can('energy.read'),
  });
  const tariffs = useQuery({ queryKey: keys.tariffs, queryFn: fetchers.tariffs, enabled: can('energy.read') });
  const acknowledge = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/meter-alerts/{id}/acknowledge', { params: { path: { id } } })),
    { invalidate: [keys.energyAll], onDone: () => toast.show('Acknowledged.') },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title="Energy" />
        <ForbiddenState />
      </>
    );
  const r: Consumption | undefined = report.data;
  const manage = can('energy.manage');
  return (
    <>
      <PageHeader
        title="Energy"
        description="What the compound used and what it cost, from the meters’ readings. A unit’s use shows when it stands empty."
        actions={
          <>
            <ButtonLink href="/energy/measures">Saving measures</ButtonLink>
            <ButtonLink href="/meters">Meters</ButtonLink>
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Kind> label="Kind" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: humanize(k) }))} />
        <Segmented<GroupBy>
          label="By"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'building', label: 'Building' },
            { value: 'area', label: 'Common area' },
            { value: 'meter', label: 'Meter' },
          ]}
        />
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <div className="grid grid--stats">
              <Stat label={`Use (${r.unit})`} value={r.use} />
              <Stat label="Cost" value={r.cost ? `${r.cost} EGP` : '—'} />
              <Stat label="Days" value={String(r.period.days)} />
            </div>
            <Card flush>
              <DataTable
                rows={r.groups}
                rowKey={(g) => g.key ?? '—'}
                empty="No meter of this kind"
                columns={[
                  { key: 'l', header: humanize(groupBy), cell: (g) => g.label ?? '—' },
                  { key: 'm', header: 'Meters', cell: (g) => g.meters },
                  { key: 'u', header: `Use (${r.unit})`, cell: (g) => g.use },
                  { key: 'c', header: 'Cost', cell: (g) => (g.cost ? `${g.cost} EGP` : '—') },
                  { key: 's', header: 'A m²', cell: (g) => g.perSqm ?? '—' },
                  { key: 'o', header: 'An occupied unit', cell: (g) => g.perOccupiedUnit ?? '—' },
                ]}
              />
            </Card>
          </>
        ) : null}
      </QueryState>
      <Card flush>
        <CardHeader title="Spikes" />
        <QueryState query={alerts}>
          <DataTable<MeterAlert>
            rows={alerts.data?.data ?? []}
            rowKey={(a) => a.id}
            empty="No spike waiting"
            columns={[
              {
                key: 'm',
                header: 'Meter',
                cell: (a) => (
                  <Link className="table__link" href={`/meters/${a.meterId}`}>
                    Open
                  </Link>
                ),
              },
              { key: 'd', header: 'Up to', cell: (a) => formatDate(a.readOn) },
              { key: 'r', header: 'A day', cell: (a) => a.dailyRate },
              { key: 'b', header: 'Usually', cell: (a) => a.baselineRate },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (a) =>
                  manage ? (
                    <Button size="sm" loading={acknowledge.isPending} onClick={() => acknowledge.mutate(a.id)}>
                      Acknowledge
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader
          title="Tariffs"
          actions={
            manage ? (
              <Button size="sm" onClick={() => setAddingTariff(true)}>
                New {humanize(kind).toLowerCase()} tariff
              </Button>
            ) : null
          }
        />
        <QueryState query={tariffs}>
          <DataTable<Tariff>
            rows={(tariffs.data ?? []).filter((t) => t.kind === kind)}
            rowKey={(t) => t.id}
            empty="No tariff: use is shown without its cost"
            columns={[
              { key: 'f', header: 'From', cell: (t) => formatDate(t.effectiveOn) },
              { key: 'p', header: 'EGP a unit', cell: (t) => t.pricePerUnit },
            ]}
          />
        </QueryState>
      </Card>
      {manage ? <SpikeRule /> : null}
      {addingTariff ? <TariffDialog kind={kind} onClose={() => setAddingTariff(false)} /> : null}
    </>
  );
}
