'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Consumption, type MeterAlert, type Tariff } from '@/lib/queries';
import ar from '@/messages/ar/energy';
import en from '@/messages/en/energy';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
type Kind = (typeof KINDS)[number];
const GROUPS = ['building', 'area', 'meter'] as const;
type GroupBy = (typeof GROUPS)[number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

function TariffDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [effectiveOn, setEffectiveOn] = useState(iso(new Date()));
  const [price, setPrice] = useState('');
  const add = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/energy/tariffs', { body: { kind, effectiveOn, pricePerUnit: price } })),
    {
      invalidate: [keys.energyAll],
      onDone: () => {
        toast.show(t('tariffAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tariffTitle', { kind: label(kind).toLowerCase() })}
      description={t('tariffDescription')}
      onSubmit={() => price && add.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!price}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={add.error} />
        <div className="form__row">
          <Field label={t('from')} error={fieldError(add.error, 'effectiveOn')}>
            {(p) => <Input {...p} type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />}
          </Field>
          <Field label={t('price')} error={fieldError(add.error, 'pricePerUnit')}>
            {(p) => <Input {...p} value={price} onChange={(e) => setPrice(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function SpikeRule() {
  const t = useT(en, ar);
  const c = useCommonT();
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
    { invalidate: [keys.energySettings], onDone: () => toast.show(t('saved')) },
  );
  const s = settings.data;
  return (
    <Card>
      <CardHeader title={t('spikeRule')}>
        <span className="text-muted">{t('spikeRuleHint')}</span>
      </CardHeader>
      <QueryState query={settings}>
        <CardBody>
          <div className="form">
            <ErrorAlert error={save.error} />
            <div className="form__row">
              <Field label={t('factor')} hint={t('factorHint')} error={fieldError(save.error, 'anomalyFactor')}>
                {(p) => <Input {...p} value={factor ?? s?.anomalyFactor ?? ''} onChange={(e) => setFactor(e.target.value)} />}
              </Field>
              <Field label={t('periods')} hint={t('periodsHint')} error={fieldError(save.error, 'anomalyPeriods')}>
                {(p) => (
                  <Input {...p} type="number" min={3} max={24} value={periods ?? String(s?.anomalyPeriods ?? '')} onChange={(e) => setPeriods(e.target.value)} />
                )}
              </Field>
            </div>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={factor === null && periods === null} onClick={() => save.mutate()}>
                {c('save')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
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
    { invalidate: [keys.energyAll], onDone: () => toast.show(t('acknowledged')) },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const r: Consumption | undefined = report.data;
  const manage = can('energy.manage');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <ButtonLink href="/energy/measures">{t('savingMeasures')}</ButtonLink>
            <ButtonLink href="/meters">{t('meters')}</ButtonLink>
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Kind> label={t('kind')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: label(k) }))} />
        <Segmented<GroupBy>
          label={t('by')}
          value={groupBy}
          onChange={setGroupBy}
          options={GROUPS.map((value) => ({ value, label: t(`group.${value}`) }))}
        />
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <div className="grid grid--stats">
              <Stat label={t('use', { unit: r.unit })} value={r.use} />
              <Stat label={t('cost')} value={r.cost ? f.money(r.cost) : '—'} />
              <Stat label={t('days')} value={String(r.period.days)} />
            </div>
            <Card flush>
              <DataTable
                rows={r.groups}
                rowKey={(g) => g.key ?? '—'}
                empty={t('emptyGroups')}
                columns={[
                  { key: 'l', header: t(`group.${groupBy}`), cell: (g) => g.label ?? '—' },
                  { key: 'm', header: t('col.meters'), cell: (g) => g.meters },
                  { key: 'u', header: t('use', { unit: r.unit }), cell: (g) => g.use },
                  { key: 'c', header: t('cost'), cell: (g) => (g.cost ? f.money(g.cost) : '—') },
                  { key: 's', header: t('col.perSqm'), cell: (g) => g.perSqm ?? '—' },
                  { key: 'o', header: t('col.perUnit'), cell: (g) => g.perOccupiedUnit ?? '—' },
                ]}
              />
            </Card>
          </>
        ) : null}
      </QueryState>
      <Card flush>
        <CardHeader title={t('spikes')} />
        <QueryState query={alerts}>
          <DataTable<MeterAlert>
            rows={alerts.data?.data ?? []}
            rowKey={(a) => a.id}
            empty={t('emptySpikes')}
            columns={[
              {
                key: 'm',
                header: t('col.meter'),
                cell: (a) => (
                  <Link className="table__link" href={`/meters/${a.meterId}`}>
                    {c('open')}
                  </Link>
                ),
              },
              { key: 'd', header: t('col.upTo'), cell: (a) => f.day(a.readOn) },
              { key: 'r', header: t('col.aDay'), cell: (a) => a.dailyRate },
              { key: 'b', header: t('col.usually'), cell: (a) => a.baselineRate },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (a) =>
                  manage ? (
                    <Button size="sm" loading={acknowledge.isPending} onClick={() => acknowledge.mutate(a.id)}>
                      {t('acknowledge')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader
          title={t('tariffs')}
          actions={
            manage ? (
              <Button size="sm" onClick={() => setAddingTariff(true)}>
                {t('newTariff', { kind: label(kind).toLowerCase() })}
              </Button>
            ) : null
          }
        />
        <QueryState query={tariffs}>
          <DataTable<Tariff>
            rows={(tariffs.data ?? []).filter((x) => x.kind === kind)}
            rowKey={(x) => x.id}
            empty={t('emptyTariffs')}
            columns={[
              { key: 'f', header: t('from'), cell: (x) => f.day(x.effectiveOn) },
              { key: 'p', header: t('price'), cell: (x) => x.pricePerUnit },
            ]}
          />
        </QueryState>
      </Card>
      {manage ? <SpikeRule /> : null}
      {addingTariff ? <TariffDialog kind={kind} onClose={() => setAddingTariff(false)} /> : null}
    </>
  );
}
