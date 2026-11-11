'use client';

import type { Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Format, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { today } from '@/components/security/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-gl-statements';
import en from '@/messages/en/fin-gl-statements';

type Row = Schema<'GlStatementRowView'>;
type Tab = 'trial' | 'income' | 'balance';
type T = Translate<typeof en>;

const amount = (f: Format, v: string) => f.number(v, { minimumFractionDigits: 2 });
const money = (f: Format, v: string) => <span className="t-mono">{amount(f, v)}</span>;

/** An account's name in the page's language. */
function useAccountCell() {
  const { locale } = useLocale();
  return (r: Row) => (
    <Link href={`/finance/gl/accounts/${r.accountId}`}>
      <span className="ltr">{r.code}</span> {locale === 'ar' ? r.nameAr : r.nameEn}
    </Link>
  );
}

function Rows({ rows, title, total, t, f }: { rows: Row[]; title: string; total?: string; t: T; f: Format }) {
  const c = useCommonT();
  const account = useAccountCell();
  return (
    <Card flush>
      <SectionHeader title={title} description={total ? t('total', { amount: amount(f, total) }) : undefined} />
      <DataTable<Row>
        rows={rows}
        rowKey={(r) => r.accountId}
        empty={t('empty')}
        columns={[
          { key: 'a', header: t('account'), cell: account },
          { key: 'm', header: c('amount'), cell: (r) => money(f, r.amount) },
        ]}
      />
    </Card>
  );
}

/**
 * The financial statements (ADR 0092): the trial balance and the balance
 * sheet on a day, the income statement of a period; each also on the
 * reports platform (PDF, workbook, CSV, compared, scheduled), and the
 * journal of a period as CSV for an outside accounting system.
 */
export default function StatementsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const c = useCommonT();
  const label = useLabel();
  const account = useAccountCell();
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const [tab, setTab] = useState<Tab>('trial');
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const trial = useQuery({ queryKey: keys.glTrialBalance(to), queryFn: () => fetchers.glTrialBalance(to), enabled: allowed && tab === 'trial' });
  const income = useQuery({
    queryKey: keys.glIncomeStatement(from, to),
    queryFn: () => fetchers.glIncomeStatement(from, to),
    enabled: allowed && tab === 'income',
  });
  const balance = useQuery({ queryKey: keys.glBalanceSheet(to), queryFn: () => fetchers.glBalanceSheet(to), enabled: allowed && tab === 'balance' });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const report = { trial: 'gl_trial_balance', income: 'gl_income_statement', balance: 'gl_balance_sheet' }[tab];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {tab === 'income' ? (
              <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            ) : null}
            <Field label={tab === 'income' ? t('to') : t('asOf')}>
              {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
            </Field>
            <Button
              onClick={() =>
                void download('/api/v1/staff/reports/export', { report, from, to, format: 'xlsx' }, `${report}.xlsx`)
              }
            >
              {t('workbook')}
            </Button>
            <Button onClick={() => void download('/api/v1/staff/reports/export', { report, from, to, format: 'csv' }, `${report}.csv`)}>
              CSV
            </Button>
            <Button onClick={() => void download('/api/v1/staff/finance/gl/journal/export', { from, to }, 'journal.csv')}>
              {t('journalCsv')}
            </Button>
          </span>
        }
      />
      <div className="stack">
        <Segmented<Tab>
          label={t('statement')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'trial', label: t('trial') },
            { value: 'income', label: t('income') },
            { value: 'balance', label: t('balance') },
          ]}
        />
        {tab === 'trial' ? (
          <QueryState query={trial} rows={6}>
            {trial.data ? (
              <Card flush>
                <SectionHeader
                  title={t('trialOn', { day: f.day(trial.data.asOf) })}
                  description={t('trialTotals', { debit: amount(f, trial.data.debit), credit: amount(f, trial.data.credit) })}
                />
                <DataTable<Row>
                  rows={trial.data.rows}
                  rowKey={(r) => r.accountId}
                  columns={[
                    { key: 'a', header: t('account'), cell: account },
                    { key: 't', header: c('type'), cell: (r) => label(r.type) },
                    { key: 'd', header: t('debit'), cell: (r) => (r.debit === '0.00' ? '' : money(f, r.debit)) },
                    { key: 'c', header: t('credit'), cell: (r) => (r.credit === '0.00' ? '' : money(f, r.credit)) },
                  ]}
                />
                <div style={{ padding: 12 }}>
                  {trial.data.balanced ? <Badge tone="green">{t('balanced')}</Badge> : <Badge tone="error">{t('outOfBalance')}</Badge>}
                </div>
              </Card>
            ) : null}
          </QueryState>
        ) : null}
        {tab === 'income' ? (
          <QueryState query={income} rows={6}>
            {income.data ? (
              <div className="stack">
                <Rows rows={income.data.revenue} title={t('revenue')} total={income.data.totalRevenue} t={t} f={f} />
                <Rows rows={income.data.expenses} title={t('expenses')} total={income.data.totalExpenses} t={t} f={f} />
                <Card>
                  <strong>{Number(income.data.surplus) < 0 ? t('deficit') : t('surplus')}</strong> {money(f, income.data.surplus)}
                </Card>
              </div>
            ) : null}
          </QueryState>
        ) : null}
        {tab === 'balance' ? (
          <QueryState query={balance} rows={6}>
            {balance.data ? (
              <div className="stack">
                <Rows rows={balance.data.assets} title={t('assets')} total={balance.data.totalAssets} t={t} f={f} />
                <Rows rows={balance.data.liabilities} title={t('liabilities')} total={balance.data.totalLiabilities} t={t} f={f} />
                <Rows rows={balance.data.equity} title={t('equity')} total={balance.data.totalEquity} t={t} f={f} />
                <Card>
                  {t('currentYearResult', { day: f.day(balance.data.fiscalYearStartsOn) })} {money(f, balance.data.currentYearResult)}
                  {Number(balance.data.priorYearsResult) !== 0 ? (
                    <>
                      {' '}
                      {t('priorYearsResult')} {money(f, balance.data.priorYearsResult)}
                    </>
                  ) : null}{' '}
                  {balance.data.balanced ? <Badge tone="green">{t('balances')}</Badge> : <Badge tone="error">{t('doesNotBalance')}</Badge>}
                </Card>
              </div>
            ) : null}
          </QueryState>
        ) : null}
      </div>
    </>
  );
}
