'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Stat, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CalendarClock, Percent, Wallet } from 'lucide-react';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { cashFlowBasisText, cashFlowRateText, liquidityDays } from '@/components/finance/cash-flow';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-cash-flow';
import codesAr from '@/messages/ar/fin-codes';
import en from '@/messages/en/fin-cash-flow';
import codesEn from '@/messages/en/fin-codes';

type Period = Schema<'CashFlowPeriodView'>;
const FLOOR = /^\d{1,12}(\.\d{1,2})?$/;

function MinimumDialog({ current, onClose }: { current: string | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [value, setValue] = useState(current ?? '');
  const save = useAction(
    (minimumCash: string | null) =>
      unwrap(api.PATCH('/api/v1/staff/finance/cash-flow/settings', { body: { minimumCash } })),
    {
      invalidate: [keys.cashFlowAll],
      onDone: () => {
        toast.show(t('minimumSaved'));
        onClose();
      },
    },
  );
  const ok = FLOOR.test(value.trim()) && Number(value) > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('minimumTitle')}
      description={t('minimumDescription')}
      onSubmit={() => ok && save.mutate(value.trim())}
      footer={
        <>
          {current ? (
            <Button variant="danger" onClick={() => save.mutate(null)} loading={save.isPending}>
              {t('turnOff')}
            </Button>
          ) : null}
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('minimumField')} error={fieldError(save.error, 'minimumCash')}>
          {(p) => <Input {...p} inputMode="decimal" className="ltr" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

const money = (v: string) => <span className="t-mono ltr">{v}</span>;

/**
 * The cash flow forecast and liquidity (ADR 0091): the accounts' balances
 * as the opening, what payables schedules out, the residents' dues at the
 * compound's collection rate in, by week or month, each period's closing
 * balance against the compound's minimum cash.
 */
export default function CashFlowPage() {
  const t = useT(en, ar);
  const k = useT(codesEn, codesAr);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('finance.cashflow');
  const [by, setBy] = useState<'week' | 'month'>('week');
  const [periods, setPeriods] = useState('13');
  const [editing, setEditing] = useState(false);
  const q = { by, periods: Number(periods) };
  const forecast = useQuery({
    queryKey: keys.cashFlow(q),
    queryFn: () => fetchers.cashFlow(q),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const f = forecast.data;
  const m = (v: string) => money(fmt.money(v));
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Select
              aria-label={t('by')}
              value={by}
              onChange={(e) => {
                const next = e.target.value as 'week' | 'month';
                setBy(next);
                setPeriods(next === 'week' ? '13' : '6');
              }}
            >
              <option value="week">{t('byWeek')}</option>
              <option value="month">{t('byMonth')}</option>
            </Select>
            <Select aria-label={t('periods')} value={periods} onChange={(e) => setPeriods(e.target.value)}>
              {(by === 'week' ? [4, 8, 13, 26] : [3, 6, 12]).map((n) => (
                <option key={n} value={String(n)}>
                  {by === 'week' ? t('weeks', { n }) : t('months', { n })}
                </option>
              ))}
            </Select>
            <Button onClick={() => void download('/api/v1/staff/finance/cash-flow/export', { by, periods }, 'cash-flow.csv')}>{t('exportCsv')}</Button>
            {can('finance.treasury') ? (
              <Button variant="primary" onClick={() => setEditing(true)}>
                {t('minimumTitle')}
              </Button>
            ) : null}
          </span>
        }
      />
      <QueryState query={forecast} rows={3}>
        {f ? (
          <div className="stack">
            <div className="grid grid--stats">
              <Stat
                tone={f.belowMinimumNow ? 'beige' : 'dark'}
                label={t('cashOnHand')}
                icon={<Wallet aria-hidden />}
                value={fmt.money(f.opening.total)}
                hint={t('accounts', { n: f.opening.accounts.length })}
                href="/finance/treasury"
              />
              <Stat
                label={t('liquidity')}
                icon={<CalendarClock aria-hidden />}
                value={liquidityDays(k, f.liquidityDays)}
                hint={t('spentPerDay', { amount: fmt.money(f.spending.daily) })}
              />
              <Stat
                label={t('collectionRate')}
                icon={<Percent aria-hidden />}
                value={cashFlowRateText(fmt, f.collection.rate)}
                hint={cashFlowBasisText(k, fmt, f.collection)}
              />
              <Stat
                tone={f.periodsBelowMinimum ? 'beige' : undefined}
                label={t('minimumTitle')}
                icon={<Banknote aria-hidden />}
                value={f.minimumCash ? fmt.money(f.minimumCash) : t('notSet')}
                hint={
                  f.minimumCash === null
                    ? t('noNotice')
                    : f.belowMinimumNow
                      ? t('belowNow')
                      : f.firstBelowMinimum
                        ? t('belowFrom', { day: fmt.day(f.firstBelowMinimum) })
                        : t('aboveThroughout')
                }
              />
            </div>
            <Card flush>
              <SectionHeader
                title={t('forecastTitle')}
                description={t('forecastDescription', {
                  count: fmt.number(f.overdue.payables.count),
                  amount: fmt.money(f.overdue.payables.amount),
                  overdue: fmt.money(f.overdue.receivables),
                  disputed: fmt.money(f.disputed),
                })}
              />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: t('col.period'), cell: (p) => (p.from === p.to ? fmt.day(p.from) : `${fmt.day(p.from)} – ${fmt.day(p.to)}`) },
                  { key: 'd', header: t('col.dues'), cell: (p) => m(p.inflows.dues) },
                  { key: 'i', header: t('col.expectedIn'), cell: (p) => m(p.inflows.total) },
                  { key: 'o', header: t('col.out'), cell: (p) => m(p.outflows.total) },
                  { key: 'n', header: t('col.net'), cell: (p) => m(p.net) },
                  {
                    key: 'c',
                    header: t('col.closing'),
                    cell: (p) => (
                      <span className="row" style={{ gap: 8 }}>
                        {m(p.closing)}
                        {p.belowMinimum ? <Badge tone="terracotta">{t('belowMinimum')}</Badge> : null}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
            <Card flush>
              <SectionHeader title={t('outTitle')} description={t('outDescription')} />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: t('col.from'), cell: (p) => fmt.day(p.from) },
                  { key: 'v', header: t('col.vendorInvoices'), cell: (p) => m(p.outflows.vendorInvoices) },
                  { key: 'c', header: t('col.contractPayments'), cell: (p) => m(p.outflows.contractPayments) },
                  { key: 'u', header: t('col.purchases'), cell: (p) => m(p.outflows.purchases) },
                  { key: 'a', header: t('col.advances'), cell: (p) => m(p.outflows.disbursements) },
                  { key: 'r', header: t('col.retentions'), cell: (p) => m(p.outflows.retentions) },
                ]}
              />
            </Card>
            <Card flush>
              <SectionHeader title={t('inTitle')} description={t('inDescription')} />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: t('col.from'), cell: (p) => fmt.day(p.from) },
                  { key: 'i', header: t('col.invoiced'), cell: (p) => m(p.inflows.invoiced) },
                  { key: 'j', header: t('col.projected'), cell: (p) => m(p.inflows.projected) },
                  { key: 'e', header: t('col.expected'), cell: (p) => m(p.inflows.expected) },
                  { key: 't', header: t('col.inTransit'), cell: (p) => m(p.inflows.inTransit) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {editing ? <MinimumDialog current={f?.minimumCash ?? null} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
