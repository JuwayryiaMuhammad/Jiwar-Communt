'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, Stat, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TechnicianStats } from '@/lib/queries';
import ar from '@/messages/ar/economics';
import en from '@/messages/en/economics';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** What maintenance cost and how it went (ADR 0065): computed on read, by rule. */
export default function EconomicsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)));
  const [to, setTo] = useState(iso(now));
  const economics = useQuery({ queryKey: keys.economics(from, to), queryFn: () => fetchers.economics(from, to), enabled: can('assets.manage') });
  const kpis = useQuery({ queryKey: keys.kpis(from, to), queryFn: () => fetchers.kpis(from, to), enabled: can('assets.manage') });
  const people = useQuery({
    queryKey: keys.technicianStats(from, to),
    queryFn: () => fetchers.technicianStats(from, to),
    enabled: can('tickets.dispatch'),
  });
  const names = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, enabled: can('tickets.dispatch') });
  const nameOf = (id: string) => names.data?.data.find((x) => x.id === id)?.fullName ?? '—';
  const pct = (v: number | null) => f.percent(v, 0);
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const e = economics.data;
  const k = kpis.data;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(x) => setFrom(x.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(x) => setTo(x.target.value)} />}</Field>
      </div>
      <QueryState query={kpis}>
        {k ? (
          <div className="grid grid--stats">
            <Stat
              label={t('plannedWork')}
              value={pct(k.plannedShare)}
              hint={t('plannedHint', { planned: f.number(k.completedPlanned), repairs: f.number(k.completedCorrective) })}
            />
            <Stat label={t('mttr')} value={k.mttrHours === null ? '—' : t('hours', { n: f.number(k.mttrHours) })} />
            <Stat
              label={t('mtbf')}
              value={k.mtbfDays === null ? '—' : t('days', { n: k.mtbfDays })}
              hint={t('failures', { n: k.failures })}
            />
            <Stat
              label={t('onTime')}
              value={pct(k.compliance)}
              hint={t('onTimeHint', { onTime: f.number(k.occurrencesOnTime), due: f.number(k.occurrencesDue) })}
            />
          </div>
        ) : null}
      </QueryState>
      <QueryState query={economics}>
        {e ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title={t('spend')}>
                  <span className="text-muted">
                    {t('spendLine', { total: f.money(e.spend.total), planned: f.money(e.spend.planned), repairs: f.money(e.spend.corrective) })}
                  </span>
                </CardHeader>
                <DataTable
                  rows={e.byMonth}
                  rowKey={(m) => m.month}
                  empty={t('nothingSpent')}
                  columns={[
                    { key: 'm', header: t('month'), cell: (m) => f.month(m.month) },
                    { key: 'a', header: c('amount'), cell: (m) => f.money(m.amount) },
                  ]}
                />
              </Card>
              <Card flush>
                <CardHeader title={t('costMost')} />
                <DataTable
                  rows={e.topAssets}
                  rowKey={(a) => a.assetId}
                  empty={t('noCost')}
                  columns={[
                    {
                      key: 'c',
                      header: t('asset'),
                      cell: (a) => (
                        <Link className="table__link ltr" href={`/assets/${a.assetId}`}>
                          {a.code}
                        </Link>
                      ),
                    },
                    { key: 'a', header: c('amount'), cell: (a) => f.money(a.amount) },
                  ]}
                />
              </Card>
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title={t('ahead')} />
                <DataTable
                  rows={e.capitalPlan}
                  rowKey={(y) => String(y.year)}
                  empty="—"
                  columns={[
                    { key: 'y', header: t('year'), cell: (y) => y.year },
                    { key: 'a', header: c('amount'), cell: (y) => f.money(y.amount) },
                    { key: 'n', header: t('assets'), cell: (y) => f.number(y.assets) },
                  ]}
                />
                <CardBody>
                  <p className="text-muted">{t('reserve', { annual: f.money(e.reserve.annual), accrued: f.money(e.reserve.accrued) })}</p>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title={t('byCategory')} />
                <DataTable
                  rows={e.byCategory}
                  rowKey={(x) => x.categoryKey}
                  empty="—"
                  columns={[
                    { key: 'c', header: c('category'), cell: (x) => label(x.categoryKey) },
                    { key: 'a', header: c('amount'), cell: (x) => f.money(x.amount) },
                  ]}
                />
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      {can('tickets.dispatch') ? (
        <Card flush>
          <CardHeader title={t('technicians')} />
          <QueryState query={people}>
            <DataTable<TechnicianStats>
              rows={people.data?.data ?? []}
              rowKey={(s) => s.technicianId}
              empty={t('noTechnician')}
              columns={[
                { key: 'n', header: t('technician'), cell: (s) => nameOf(s.technicianId) },
                { key: 'c', header: t('completed'), cell: (s) => f.number(s.completed) },
                { key: 'h', header: t('hoursToComplete'), cell: (s) => f.number(s.meanHoursToComplete) },
                { key: 'b', header: t('sentBack'), cell: (s) => f.number(s.sentBack) },
                { key: 's', header: t('slaMet'), cell: (s) => pct(s.slaAdherence) },
                {
                  key: 'r',
                  header: t('rating'),
                  cell: (s) => (s.meanRating === null ? `— (${f.number(s.ratings)})` : `${f.number(s.meanRating)} (${f.number(s.ratings)})`),
                },
                { key: 'i', header: t('inHand'), cell: (s) => f.number(s.inHand) },
              ]}
            />
          </QueryState>
        </Card>
      ) : null}
    </>
  );
}
