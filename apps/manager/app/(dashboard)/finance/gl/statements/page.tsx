'use client';

import type { Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { today } from '@/components/security/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Row = Schema<'GlStatementRowView'>;
type Tab = 'trial' | 'income' | 'balance';

const money = (v: string) => <span className="t-mono">{v}</span>;
const account = (r: Row) => <Link href={`/finance/gl/accounts/${r.accountId}`}>{`${r.code} ${r.nameEn}`}</Link>;

function Rows({ rows, title, total }: { rows: Row[]; title: string; total?: string }) {
  return (
    <Card flush>
      <SectionHeader title={title} description={total ? `Total ${total}` : undefined} />
      <DataTable<Row>
        rows={rows}
        rowKey={(r) => r.accountId}
        empty="Nothing here"
        columns={[
          { key: 'a', header: 'Account', cell: account },
          { key: 'm', header: 'Amount', cell: (r) => money(r.amount) },
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
        <PageHeader title="Financial statements" />
        <ForbiddenState />
      </>
    );
  const report = { trial: 'gl_trial_balance', income: 'gl_income_statement', balance: 'gl_balance_sheet' }[tab];
  return (
    <>
      <PageHeader
        title="Financial statements"
        description="From the general ledger: every figure a sum of its posted lines."
        actions={
          <span className="row" style={{ gap: 8 }}>
            {tab === 'income' ? (
              <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            ) : null}
            <Field label={tab === 'income' ? 'To' : 'As of'}>
              {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
            </Field>
            <Button
              onClick={() =>
                void download('/api/v1/staff/reports/export', { report, from, to, format: 'xlsx' }, `${report}.xlsx`)
              }
            >
              Workbook
            </Button>
            <Button onClick={() => void download('/api/v1/staff/reports/export', { report, from, to, format: 'csv' }, `${report}.csv`)}>
              CSV
            </Button>
            <Button onClick={() => void download('/api/v1/staff/finance/gl/journal/export', { from, to }, 'journal.csv')}>
              Journal CSV
            </Button>
          </span>
        }
      />
      <div className="stack">
        <Segmented<Tab>
          label="Statement"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'trial', label: 'Trial balance' },
            { value: 'income', label: 'Income statement' },
            { value: 'balance', label: 'Balance sheet' },
          ]}
        />
        {tab === 'trial' ? (
          <QueryState query={trial} rows={6}>
            {trial.data ? (
              <Card flush>
                <SectionHeader
                  title={`Trial balance on ${trial.data.asOf}`}
                  description={`Debits ${trial.data.debit}, credits ${trial.data.credit}.`}
                />
                <DataTable<Row>
                  rows={trial.data.rows}
                  rowKey={(r) => r.accountId}
                  columns={[
                    { key: 'a', header: 'Account', cell: account },
                    { key: 't', header: 'Type', cell: (r) => r.type },
                    { key: 'd', header: 'Debit', cell: (r) => (r.debit === '0.00' ? '' : money(r.debit)) },
                    { key: 'c', header: 'Credit', cell: (r) => (r.credit === '0.00' ? '' : money(r.credit)) },
                  ]}
                />
                <div style={{ padding: 12 }}>
                  {trial.data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="error">Out of balance</Badge>}
                </div>
              </Card>
            ) : null}
          </QueryState>
        ) : null}
        {tab === 'income' ? (
          <QueryState query={income} rows={6}>
            {income.data ? (
              <div className="stack">
                <Rows rows={income.data.revenue} title="Revenue" total={income.data.totalRevenue} />
                <Rows rows={income.data.expenses} title="Expenses" total={income.data.totalExpenses} />
                <Card>
                  <strong>{Number(income.data.surplus) < 0 ? 'Deficit' : 'Surplus'}</strong> {money(income.data.surplus)}
                </Card>
              </div>
            ) : null}
          </QueryState>
        ) : null}
        {tab === 'balance' ? (
          <QueryState query={balance} rows={6}>
            {balance.data ? (
              <div className="stack">
                <Rows rows={balance.data.assets} title="Assets" total={balance.data.totalAssets} />
                <Rows rows={balance.data.liabilities} title="Liabilities" total={balance.data.totalLiabilities} />
                <Rows rows={balance.data.equity} title="Equity" total={balance.data.totalEquity} />
                <Card>
                  Surplus to date, not yet closed into equity: {money(balance.data.surplus)}{' '}
                  {balance.data.balanced ? <Badge tone="green">Balances</Badge> : <Badge tone="error">Does not balance</Badge>}
                </Card>
              </div>
            ) : null}
          </QueryState>
        ) : null}
      </div>
    </>
  );
}
