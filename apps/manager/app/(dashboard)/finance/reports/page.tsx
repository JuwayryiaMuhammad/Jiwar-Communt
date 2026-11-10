'use client';

import { useErrorText } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Stat, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { firstOfMonth } from '@/components/finance/logic';
import { codeText } from '@/components/governance/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type AgingReport,
  type BudgetVsActual,
  type CollectionsReport,
  type DailyCashReport,
  type OutstandingReport,
  type UnitReportFilters,
} from '@/lib/queries';
import govAr from '@/messages/ar/gov-codes';
import ar from '@/messages/ar/fin-reports';
import govEn from '@/messages/en/gov-codes';
import en from '@/messages/en/fin-reports';

type Tab = 'aging' | 'collections' | 'outstanding' | 'daily-cash' | 'budget-vs-actual';
const today = () => new Date().toLocaleDateString('en-CA');

/** A report's CSV, saved under the server's name. */
function ExportButton({ name, query }: { name: Tab; query: Record<string, string | undefined> }) {
  const t = useT(en, ar);
  const [busy, setBusy] = useState(false);
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        icon={<Download aria-hidden />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await download(`/api/v1/staff/finance/reports/${name}/export`, query, `${name}.csv`);
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('exportCsv')}
      </Button>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </>
  );
}

function UnitGrouping({ value, onChange }: { value: UnitReportFilters; onChange: (v: UnitReportFilters) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  return (
    <>
      <Segmented<UnitReportFilters['groupBy']>
        label={t('per')}
        value={value.groupBy}
        onChange={(groupBy) => onChange({ ...value, groupBy })}
        options={[
          { value: 'unit', label: t('perUnit') },
          { value: 'building', label: t('perBuilding') },
        ]}
      />
      <Field label={c('building')}>{(p) => <Input {...p} value={value.building ?? ''} onChange={(e) => onChange({ ...value, building: e.target.value })} />}</Field>
    </>
  );
}

function Aging() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const [g, setG] = useState<UnitReportFilters>({ groupBy: 'unit' });
  const q = { ...g, building: g.building?.trim() || undefined };
  const report = useQuery({ queryKey: keys.report('aging', q), queryFn: () => fetchers.aging(q) });
  type Row = AgingReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <UnitGrouping value={g} onChange={setG} />
        <ExportButton name="aging" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <Card flush>
            <DataTable<Row>
              rows={[...report.data.rows, { ...report.data.totals, unitCode: c('total'), building: null }]}
              rowKey={(r) => `${r.unitId ?? ''}-${r.building ?? ''}-${r.unitCode ?? ''}`}
              empty={t('aging.empty')}
              columns={[
                { key: 'u', header: g.groupBy === 'unit' ? c('unit') : c('building'), cell: (r) => (g.groupBy === 'unit' ? r.unitCode : (r.building ?? r.unitCode ?? '—')) },
                { key: 'n', header: t('aging.notDue'), cell: (r) => f.money(r.notDue) },
                { key: '30', header: t('aging.d30'), cell: (r) => f.money(r.days1to30) },
                { key: '60', header: t('aging.d60'), cell: (r) => f.money(r.days31to60) },
                { key: '90', header: t('aging.d90'), cell: (r) => f.money(r.days61to90) },
                { key: '91', header: t('aging.d91'), cell: (r) => f.money(r.days91plus) },
                { key: 't', header: c('total'), cell: (r) => <strong>{f.money(r.total)}</strong> },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}

function Collections() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const code = useFinanceCode();
  const [from, setFrom] = useState(firstOfMonth(today()));
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<'day' | 'month'>('day');
  const q = { from, to, groupBy };
  const report = useQuery({ queryKey: keys.report('collections', q), queryFn: () => fetchers.collections(q), enabled: Boolean(from && to) });
  type Row = CollectionsReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Segmented<'day' | 'month'>
          label={t('per')}
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'day', label: t('perDay') },
            { value: 'month', label: t('perMonth') },
          ]}
        />
        <ExportButton name="collections" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <>
            <div className="row" style={{ gap: 16 }}>
              <Stat label={t('received')} value={f.money(report.data.gross)} />
              <Stat label={t('reversed')} value={f.money(report.data.reversed)} />
              <Stat label={t('net')} value={f.money(report.data.net)} />
            </div>
            <Card flush>
              <DataTable<Row>
                rows={report.data.rows}
                rowKey={(r) => `${r.period}-${r.channel}-${r.method}`}
                empty={t('collections.empty')}
                columns={[
                  { key: 'p', header: t('period'), cell: (r) => f.day(r.period) },
                  { key: 'c', header: t('channel'), cell: (r) => label(r.channel === 'online' ? 'online' : 'office') },
                  { key: 'm', header: t('method'), cell: (r) => code('method', r.method) },
                  { key: 'n', header: t('payments'), cell: (r) => f.number(r.payments) },
                  { key: 'g', header: t('received'), cell: (r) => f.money(r.gross) },
                  { key: 'rv', header: t('reversed'), cell: (r) => (r.reversals ? `${f.money(r.reversed)} (${f.number(r.reversals)})` : '—') },
                  { key: 'net', header: t('net'), cell: (r) => <strong>{f.money(r.net)}</strong> },
                ]}
              />
            </Card>
          </>
        ) : null}
      </QueryState>
    </div>
  );
}

function Outstanding() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const [g, setG] = useState<UnitReportFilters>({ groupBy: 'unit' });
  const q = { ...g, building: g.building?.trim() || undefined };
  const report = useQuery({ queryKey: keys.report('outstanding', q), queryFn: () => fetchers.outstanding(q) });
  type Row = OutstandingReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <UnitGrouping value={g} onChange={setG} />
        <ExportButton name="outstanding" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <Card flush>
            <DataTable<Row>
              rows={[...report.data.rows, { ...report.data.totals, unitCode: c('total'), building: null }]}
              rowKey={(r) => `${r.unitId ?? ''}-${r.building ?? ''}-${r.unitCode ?? ''}`}
              empty={t('outstanding.empty')}
              columns={[
                { key: 'u', header: g.groupBy === 'unit' ? c('unit') : c('building'), cell: (r) => (g.groupBy === 'unit' ? r.unitCode : (r.building ?? r.unitCode ?? '—')) },
                { key: 'i', header: t('openInvoices'), cell: (r) => f.number(r.openInvoices) },
                { key: 'o', header: t('owed'), cell: (r) => f.money(r.outstanding) },
                { key: 'od', header: t('overdue'), cell: (r) => f.money(r.overdue) },
                { key: 'c', header: t('credit'), cell: (r) => f.money(r.credit) },
                { key: 'n', header: t('net'), cell: (r) => <strong>{f.money(r.net)}</strong> },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}

function DailyCash() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const code = useFinanceCode();
  const [day, setDay] = useState(today());
  const report = useQuery({ queryKey: keys.report('daily-cash', { day }), queryFn: () => fetchers.dailyCash(day), enabled: Boolean(day) });
  type Row = DailyCashReport['rows'][number];
  type Event = DailyCashReport['events'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label={t('day')}>{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <ExportButton name="daily-cash" query={{ day }} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <>
            <Stat label={t('netForDay')} value={f.money(report.data.net)} />
            <Card flush>
              <DataTable<Row>
                rows={report.data.rows}
                rowKey={(r) => `${r.recordedBy.id}-${r.method}`}
                empty={t('daily.empty')}
                columns={[
                  { key: 'w', header: t('recordedBy'), cell: (r) => r.recordedBy.fullName ?? c('erasedAccount') },
                  { key: 'm', header: t('method'), cell: (r) => code('method', r.method) },
                  { key: 'p', header: t('received'), cell: (r) => `${f.money(r.received)} (${f.number(r.payments)})` },
                  { key: 'rv', header: t('reversed'), cell: (r) => (r.reversals ? `${f.money(r.reversed)} (${f.number(r.reversals)})` : '—') },
                  { key: 'rf', header: t('refundedInCash'), cell: (r) => (r.refunds ? `${f.money(r.refunded)} (${f.number(r.refunds)})` : '—') },
                  { key: 'n', header: t('net'), cell: (r) => <strong>{f.money(r.net)}</strong> },
                ]}
              />
            </Card>
            <Card flush>
              <DataTable<Event>
                rows={report.data.events}
                rowKey={(e) => `${e.kind}-${e.number}-${String(e.at)}`}
                empty=""
                columns={[
                  { key: 'a', header: t('when'), cell: (e) => f.dateTime(e.at) },
                  { key: 'k', header: t('what'), cell: (e) => code('ledger', e.kind) },
                  { key: 'n', header: t('number'), cell: (e) => <span className="t-mono ltr">{e.number}</span> },
                  { key: 'u', header: c('unit'), cell: (e) => <span className="t-mono ltr">{e.unitCode}</span> },
                  { key: 'r', header: t('reference'), cell: (e) => e.reference ?? '' },
                  { key: 'amt', header: c('amount'), cell: (e) => f.money(e.amount) },
                ]}
              />
            </Card>
          </>
        ) : null}
      </QueryState>
    </div>
  );
}

/**
 * Budget vs actual (ADR 0055): per line of a budget, the budgeted amount,
 * the approved increases, what was spent and what is left; totals last.
 * By default the active budget of the year under way.
 */
function BudgetVsActualReport({ budgetId }: { budgetId: string }) {
  const t = useT(en, ar);
  const gov = useT(govEn, govAr);
  const f = useFormat();
  const report = useQuery({ queryKey: keys.budgetVsActual(budgetId), queryFn: () => fetchers.budgetVsActual(budgetId) });
  type Row = BudgetVsActual['rows'][number];
  const r = report.data;
  const pct = (v: number | string) => f.percent(Number(v) / 100, 1);
  return (
    <div className="stack">
      <div className="toolbar">
        <ExportButton name="budget-vs-actual" query={{ budgetId: budgetId || undefined }} />
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <p className="t-secondary">
              {t('budgetHead', { year: String(r.fiscalYear), from: f.day(r.startsOn), to: f.day(r.endsOn), asOf: f.day(r.asOf) })}
            </p>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <Stat label={t('allowance')} value={f.money(r.totals.allowance)} />
              <Stat label={t('actual')} value={f.money(r.totals.actual)} />
              <Stat label={t('remaining')} value={f.money(r.totals.remaining)} />
              <Stat label={t('used')} value={pct(r.totals.usedPct)} />
            </div>
            <Card flush>
              <DataTable<Row>
                rows={r.rows}
                rowKey={(x) => x.category}
                empty={t('budget.empty')}
                columns={[
                  { key: 'c', header: t('line'), cell: (x) => codeText(gov, 'category', x.category) },
                  { key: 'b', header: t('budgeted'), cell: (x) => f.money(x.budgeted) },
                  { key: 'i', header: t('increases'), cell: (x) => f.money(x.increases) },
                  { key: 'w', header: t('allowance'), cell: (x) => f.money(x.allowance) },
                  { key: 'a', header: t('actual'), cell: (x) => f.money(x.actual) },
                  { key: 'r', header: t('remaining'), cell: (x) => f.money(x.remaining) },
                  { key: 'u', header: t('used'), cell: (x) => pct(x.usedPct) },
                ]}
              />
            </Card>
          </>
        ) : null}
      </QueryState>
    </div>
  );
}

/** The finance reports (ADR 0048), each with its CSV. */
export default function ReportsPage() {
  return (
    <Suspense>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  // A budget's page links here with its id: that report, for that budget.
  const budgetId = useSearchParams().get('budget') ?? '';
  const [tab, setTab] = useState<Tab>(budgetId ? 'budget-vs-actual' : 'aging');
  if (ready && !can('finance.reports'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Tab>
          label={t('report')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'aging', label: t('tab.aging') },
            { value: 'collections', label: t('tab.collections') },
            { value: 'outstanding', label: t('tab.outstanding') },
            { value: 'daily-cash', label: t('tab.daily-cash') },
            { value: 'budget-vs-actual', label: t('tab.budget-vs-actual') },
          ]}
        />
      </div>
      {tab === 'aging' ? (
        <Aging />
      ) : tab === 'collections' ? (
        <Collections />
      ) : tab === 'outstanding' ? (
        <Outstanding />
      ) : tab === 'daily-cash' ? (
        <DailyCash />
      ) : (
        <BudgetVsActualReport budgetId={budgetId} />
      )}
    </>
  );
}
