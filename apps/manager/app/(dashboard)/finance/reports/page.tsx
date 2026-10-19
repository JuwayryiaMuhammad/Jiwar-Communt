'use client';

import { errorText, formatDateTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { egp } from '@/components/club/logic';
import { firstOfMonth, METHOD_TEXT } from '@/components/finance/logic';
import { CATEGORY_TEXT } from '@/components/governance/matters';
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

type Tab = 'aging' | 'collections' | 'outstanding' | 'daily-cash' | 'budget-vs-actual';
const today = () => new Date().toLocaleDateString('en-CA');

/** A report's CSV, saved under the server's name. */
function ExportButton({ name, query }: { name: Tab; query: Record<string, string | undefined> }) {
  const [busy, setBusy] = useState(false);
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
        Export CSV
      </Button>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </>
  );
}

function UnitGrouping({ value, onChange }: { value: UnitReportFilters; onChange: (v: UnitReportFilters) => void }) {
  return (
    <>
      <Segmented<UnitReportFilters['groupBy']>
        label="Per"
        value={value.groupBy}
        onChange={(groupBy) => onChange({ ...value, groupBy })}
        options={[
          { value: 'unit', label: 'Unit' },
          { value: 'building', label: 'Building' },
        ]}
      />
      <Field label="Building">{(p) => <Input {...p} value={value.building ?? ''} onChange={(e) => onChange({ ...value, building: e.target.value })} />}</Field>
    </>
  );
}

function Aging() {
  const [f, setF] = useState<UnitReportFilters>({ groupBy: 'unit' });
  const q = { ...f, building: f.building?.trim() || undefined };
  const report = useQuery({ queryKey: keys.report('aging', q), queryFn: () => fetchers.aging(q) });
  type Row = AgingReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <UnitGrouping value={f} onChange={setF} />
        <ExportButton name="aging" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <Card flush>
            <DataTable<Row>
              rows={[...report.data.rows, { ...report.data.totals, unitCode: 'Total', building: null }]}
              rowKey={(r) => `${r.unitId ?? ''}-${r.building ?? ''}-${r.unitCode ?? ''}`}
              empty="Nothing is owed"
              columns={[
                { key: 'u', header: f.groupBy === 'unit' ? 'Unit' : 'Building', cell: (r) => (f.groupBy === 'unit' ? r.unitCode : (r.building ?? r.unitCode ?? '—')) },
                { key: 'n', header: 'Not yet due', cell: (r) => egp(r.notDue) },
                { key: '30', header: '1–30 days', cell: (r) => egp(r.days1to30) },
                { key: '60', header: '31–60', cell: (r) => egp(r.days31to60) },
                { key: '90', header: '61–90', cell: (r) => egp(r.days61to90) },
                { key: '91', header: '91+', cell: (r) => egp(r.days91plus) },
                { key: 't', header: 'Total', cell: (r) => <strong>{egp(r.total)}</strong> },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}

function Collections() {
  const [from, setFrom] = useState(firstOfMonth(today()));
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<'day' | 'month'>('day');
  const q = { from, to, groupBy };
  const report = useQuery({ queryKey: keys.report('collections', q), queryFn: () => fetchers.collections(q), enabled: Boolean(from && to) });
  type Row = CollectionsReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Segmented<'day' | 'month'>
          label="Per"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <ExportButton name="collections" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <>
            <div className="row" style={{ gap: 16 }}>
              <Stat label="Received" value={egp(report.data.gross)} />
              <Stat label="Reversed" value={egp(report.data.reversed)} />
              <Stat label="Net" value={egp(report.data.net)} />
            </div>
            <Card flush>
              <DataTable<Row>
                rows={report.data.rows}
                rowKey={(r) => `${r.period}-${r.channel}-${r.method}`}
                empty="Nothing received in this period"
                columns={[
                  { key: 'p', header: 'Period', cell: (r) => r.period },
                  { key: 'c', header: 'Channel', cell: (r) => (r.channel === 'online' ? 'Online' : 'Office') },
                  { key: 'm', header: 'Method', cell: (r) => METHOD_TEXT[r.method] ?? r.method },
                  { key: 'n', header: 'Payments', cell: (r) => r.payments },
                  { key: 'g', header: 'Received', cell: (r) => egp(r.gross) },
                  { key: 'rv', header: 'Reversed', cell: (r) => (r.reversals ? `${egp(r.reversed)} (${r.reversals})` : '—') },
                  { key: 'net', header: 'Net', cell: (r) => <strong>{egp(r.net)}</strong> },
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
  const [f, setF] = useState<UnitReportFilters>({ groupBy: 'unit' });
  const q = { ...f, building: f.building?.trim() || undefined };
  const report = useQuery({ queryKey: keys.report('outstanding', q), queryFn: () => fetchers.outstanding(q) });
  type Row = OutstandingReport['rows'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <UnitGrouping value={f} onChange={setF} />
        <ExportButton name="outstanding" query={q} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <Card flush>
            <DataTable<Row>
              rows={[...report.data.rows, { ...report.data.totals, unitCode: 'Total', building: null }]}
              rowKey={(r) => `${r.unitId ?? ''}-${r.building ?? ''}-${r.unitCode ?? ''}`}
              empty="Nothing is owed and no credit is held"
              columns={[
                { key: 'u', header: f.groupBy === 'unit' ? 'Unit' : 'Building', cell: (r) => (f.groupBy === 'unit' ? r.unitCode : (r.building ?? r.unitCode ?? '—')) },
                { key: 'i', header: 'Open invoices', cell: (r) => r.openInvoices },
                { key: 'o', header: 'Owed', cell: (r) => egp(r.outstanding) },
                { key: 'od', header: 'Of it overdue', cell: (r) => egp(r.overdue) },
                { key: 'c', header: 'Credit', cell: (r) => egp(r.credit) },
                { key: 'n', header: 'Net', cell: (r) => <strong>{egp(r.net)}</strong> },
              ]}
            />
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}

function DailyCash() {
  const [day, setDay] = useState(today());
  const report = useQuery({ queryKey: keys.report('daily-cash', { day }), queryFn: () => fetchers.dailyCash(day), enabled: Boolean(day) });
  type Row = DailyCashReport['rows'][number];
  type Event = DailyCashReport['events'][number];
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label="Day">{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <ExportButton name="daily-cash" query={{ day }} />
      </div>
      <QueryState query={report}>
        {report.data ? (
          <>
            <Stat label="Net for the day" value={egp(report.data.net)} />
            <Card flush>
              <DataTable<Row>
                rows={report.data.rows}
                rowKey={(r) => `${r.recordedBy.id}-${r.method}`}
                empty="Nothing recorded at the office that day"
                columns={[
                  { key: 'w', header: 'Recorded by', cell: (r) => r.recordedBy.fullName ?? 'An erased account' },
                  { key: 'm', header: 'Method', cell: (r) => METHOD_TEXT[r.method] ?? r.method },
                  { key: 'p', header: 'Received', cell: (r) => `${egp(r.received)} (${r.payments})` },
                  { key: 'rv', header: 'Reversed', cell: (r) => (r.reversals ? `${egp(r.reversed)} (${r.reversals})` : '—') },
                  { key: 'rf', header: 'Refunded in cash', cell: (r) => (r.refunds ? `${egp(r.refunded)} (${r.refunds})` : '—') },
                  { key: 'n', header: 'Net', cell: (r) => <strong>{egp(r.net)}</strong> },
                ]}
              />
            </Card>
            <Card flush>
              <DataTable<Event>
                rows={report.data.events}
                rowKey={(e) => `${e.kind}-${e.number}-${String(e.at)}`}
                empty=""
                columns={[
                  { key: 'a', header: 'When', cell: (e) => formatDateTime(e.at) },
                  { key: 'k', header: 'What', cell: (e) => e.kind.replace(/_/g, ' ') },
                  { key: 'n', header: 'Number', cell: (e) => <span className="t-mono">{e.number}</span> },
                  { key: 'u', header: 'Unit', cell: (e) => <span className="t-mono">{e.unitCode}</span> },
                  { key: 'r', header: 'Reference', cell: (e) => e.reference ?? '' },
                  { key: 'amt', header: 'Amount', cell: (e) => egp(e.amount) },
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
  const report = useQuery({ queryKey: keys.budgetVsActual(budgetId), queryFn: () => fetchers.budgetVsActual(budgetId) });
  type Row = BudgetVsActual['rows'][number];
  const r = report.data;
  return (
    <div className="stack">
      <div className="toolbar">
        <ExportButton name="budget-vs-actual" query={{ budgetId: budgetId || undefined }} />
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <p className="t-secondary">
              Budget {r.fiscalYear} ({r.startsOn} – {r.endsOn}) · as of {r.asOf}
            </p>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <Stat label="Allowance" value={egp(r.totals.allowance)} />
              <Stat label="Actual" value={egp(r.totals.actual)} />
              <Stat label="Remaining" value={egp(r.totals.remaining)} />
              <Stat label="Used" value={`${r.totals.usedPct} %`} />
            </div>
            <Card flush>
              <DataTable<Row>
                rows={r.rows}
                rowKey={(x) => x.category}
                empty="No lines"
                columns={[
                  { key: 'c', header: 'Line', cell: (x) => CATEGORY_TEXT[x.category] },
                  { key: 'b', header: 'Budgeted', cell: (x) => egp(x.budgeted) },
                  { key: 'i', header: 'Increases', cell: (x) => egp(x.increases) },
                  { key: 'w', header: 'Allowance', cell: (x) => egp(x.allowance) },
                  { key: 'a', header: 'Actual', cell: (x) => egp(x.actual) },
                  { key: 'r', header: 'Remaining', cell: (x) => egp(x.remaining) },
                  { key: 'u', header: 'Used', cell: (x) => `${x.usedPct} %` },
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
  const { ready, can } = usePermissions();
  // A budget's page links here with its id: that report, for that budget.
  const budgetId = useSearchParams().get('budget') ?? '';
  const [tab, setTab] = useState<Tab>(budgetId ? 'budget-vs-actual' : 'aging');
  if (ready && !can('finance.reports'))
    return (
      <>
        <PageHeader title="Finance reports" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Finance reports"
        description="What is owed and since when, what came in, the office’s day for its closing, and the budget against what was spent."
      />
      <div className="toolbar">
        <Segmented<Tab>
          label="Report"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'aging', label: 'Aging' },
            { value: 'collections', label: 'Collections' },
            { value: 'outstanding', label: 'Outstanding' },
            { value: 'daily-cash', label: 'Daily cash' },
            { value: 'budget-vs-actual', label: 'Budget vs actual' },
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
