'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CalendarClock, Percent, Wallet } from 'lucide-react';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { cashFlowBasis, cashFlowRate, liquidityText } from '@/components/finance/cash-flow';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Period = Schema<'CashFlowPeriodView'>;
const FLOOR = /^\d{1,12}(\.\d{1,2})?$/;

function MinimumDialog({ current, onClose }: { current: string | null; onClose: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState(current ?? '');
  const save = useAction(
    (minimumCash: string | null) =>
      unwrap(api.PATCH('/api/v1/staff/finance/cash-flow/settings', { body: { minimumCash } })),
    {
      invalidate: [keys.cashFlowAll],
      onDone: () => {
        toast.show('Minimum cash saved.');
        onClose();
      },
    },
  );
  const ok = FLOOR.test(value.trim()) && Number(value) > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Minimum cash"
      description="The least cash the compound wants to hold. A period of the forecast closing below it is flagged, and whoever reads cash flow is told once a dip, at most once a day."
      onSubmit={() => ok && save.mutate(value.trim())}
      footer={
        <>
          {current ? (
            <Button variant="danger" onClick={() => save.mutate(null)} loading={save.isPending}>
              Turn off
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Minimum, EGP" error={fieldError(save.error, 'minimumCash')}>
          {(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

const money = (v: string) => <span className="t-mono">{v}</span>;

/**
 * The cash flow forecast and liquidity (ADR 0091): the accounts' balances
 * as the opening, what payables schedules out, the residents' dues at the
 * compound's collection rate in, by week or month, each period's closing
 * balance against the compound's minimum cash.
 */
export default function CashFlowPage() {
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
        <PageHeader title="Cash flow" />
        <ForbiddenState />
      </>
    );
  const f = forecast.data;
  return (
    <>
      <PageHeader
        title="Cash flow"
        description="From today: the bank and cash accounts’ balances, what payables already schedules out, and what the residents’ dues bring in at the compound’s collection rate."
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Select
              aria-label="By"
              value={by}
              onChange={(e) => {
                const next = e.target.value as 'week' | 'month';
                setBy(next);
                setPeriods(next === 'week' ? '13' : '6');
              }}
            >
              <option value="week">By week</option>
              <option value="month">By month</option>
            </Select>
            <Select aria-label="Periods" value={periods} onChange={(e) => setPeriods(e.target.value)}>
              {(by === 'week' ? [4, 8, 13, 26] : [3, 6, 12]).map((n) => (
                <option key={n} value={String(n)}>
                  {n} {by === 'week' ? 'weeks' : 'months'}
                </option>
              ))}
            </Select>
            <Button onClick={() => void download('/api/v1/staff/finance/cash-flow/export', { by, periods }, 'cash-flow.csv')}>Export CSV</Button>
            {can('finance.treasury') ? (
              <Button variant="primary" onClick={() => setEditing(true)}>
                Minimum cash
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
                label="Cash on hand"
                icon={<Wallet aria-hidden />}
                value={`${f.opening.total} ${f.currency}`}
                hint={`${f.opening.accounts.length} account${f.opening.accounts.length === 1 ? '' : 's'}`}
                href="/finance/treasury"
              />
              <Stat
                label="Liquidity"
                icon={<CalendarClock aria-hidden />}
                value={liquidityText(f.liquidityDays)}
                hint={`${f.spending.daily} ${f.currency} a day spent over the last 90 days`}
              />
              <Stat
                label="Collection rate"
                icon={<Percent aria-hidden />}
                value={cashFlowRate(f.collection.rate)}
                hint={cashFlowBasis(f.collection)}
              />
              <Stat
                tone={f.periodsBelowMinimum ? 'beige' : undefined}
                label="Minimum cash"
                icon={<Banknote aria-hidden />}
                value={f.minimumCash ? `${f.minimumCash} ${f.currency}` : 'Not set'}
                hint={
                  f.minimumCash === null
                    ? 'No notice'
                    : f.belowMinimumNow
                      ? 'Below it now'
                      : f.firstBelowMinimum
                        ? `Below it from ${f.firstBelowMinimum}`
                        : 'Above it throughout'
                }
              />
            </div>
            <Card flush>
              <SectionHeader
                title="The forecast"
                description={`Overdue payables (${f.overdue.payables.count}, ${f.overdue.payables.amount} ${f.currency}) fall in the first period. Residents’ dues past their day (${f.overdue.receivables}) and under dispute (${f.disputed}) are not counted.`}
              />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: 'Period', cell: (p) => (p.from === p.to ? p.from : `${p.from} – ${p.to}`) },
                  { key: 'd', header: 'Dues', cell: (p) => money(p.inflows.dues) },
                  { key: 'i', header: 'Expected in', cell: (p) => money(p.inflows.total) },
                  { key: 'o', header: 'Out', cell: (p) => money(p.outflows.total) },
                  { key: 'n', header: 'Net', cell: (p) => money(p.net) },
                  {
                    key: 'c',
                    header: 'Closing',
                    cell: (p) => (
                      <span className="row" style={{ gap: 8 }}>
                        {money(p.closing)}
                        {p.belowMinimum ? <Badge tone="terracotta">Below minimum</Badge> : null}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
            <Card flush>
              <SectionHeader title="What goes out" description="Only what payables already schedules: nothing is invented." />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: 'From', cell: (p) => p.from },
                  { key: 'v', header: 'Vendors’ invoices', cell: (p) => money(p.outflows.vendorInvoices) },
                  { key: 'c', header: 'Contract payments', cell: (p) => money(p.outflows.contractPayments) },
                  { key: 'u', header: 'Purchases', cell: (p) => money(p.outflows.purchases) },
                  { key: 'a', header: 'Advances and releases', cell: (p) => money(p.outflows.disbursements) },
                  { key: 'r', header: 'Retentions', cell: (p) => money(p.outflows.retentions) },
                ]}
              />
            </Card>
            <Card flush>
              <SectionHeader title="What comes in" description="Dues at the collection rate, and money collected but not yet in an account." />
              <DataTable<Period>
                rows={f.periods}
                rowKey={(p) => p.from}
                columns={[
                  { key: 'p', header: 'From', cell: (p) => p.from },
                  { key: 'i', header: 'Invoiced', cell: (p) => money(p.inflows.invoiced) },
                  { key: 'j', header: 'Projected', cell: (p) => money(p.inflows.projected) },
                  { key: 'e', header: 'Expected', cell: (p) => money(p.inflows.expected) },
                  { key: 't', header: 'On its way', cell: (p) => money(p.inflows.inTransit) },
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
