'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { egp } from '@/components/club/logic';
import { BUDGET_STATUS_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Budget, type BudgetStatus } from '@/lib/queries';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Draft({ budgets, onClose }: { budgets: Budget[]; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const thisYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(String(thisYear + 1));
  const [copyFromId, setCopyFromId] = useState('');
  const draft = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/budgets', {
          body: { fiscalYear: Number(fiscalYear), ...(copyFromId ? { copyFromId } : {}) },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: (b) => {
        toast.show('Drafted. Set its lines, then submit it to the board.');
        onClose();
        router.push(`/finance/budgets/${b.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Draft a budget"
      description="One live budget per fiscal year: a rejected or withdrawn one is final, and a new draft can copy its lines."
      onSubmit={() => draft.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={draft.isPending}>
            Draft
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Fiscal year" error={fieldError(draft.error, 'fiscalYear')}>
          {(p) => (
            <Select {...p} value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)}>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Copy the lines of" error={fieldError(draft.error, 'copyFromId')}>
          {(p) => (
            <Select {...p} value={copyFromId} onChange={(e) => setCopyFromId(e.target.value)}>
              <option value="">Nothing: start empty</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.fiscalYear} · {BUDGET_STATUS_TEXT[b.status]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={draft.error} />
      </div>
    </Dialog>
  );
}

function FiscalYearSetting() {
  const toast = useToast();
  const q = useQuery({ queryKey: keys.budgetSettings, queryFn: fetchers.budgetSettings });
  const [month, setMonth] = useState('');
  useEffect(() => {
    if (q.data) setMonth(String(q.data.fiscalYearStartMonth));
  }, [q.data]);
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/staff/finance/budget-settings', { body: { fiscalYearStartMonth: Number(month) } })),
    { invalidate: [keys.budgetSettings], onDone: () => toast.show('Saved.') },
  );
  return (
    <Card>
      <CardHeader title="Fiscal year">
        <span className="t-secondary">The month it starts on. Fixed once a budget was submitted.</span>
      </CardHeader>
      <QueryState query={q}>
        <div className="toolbar">
          <Field label="Starts in" error={fieldError(save.error, 'fiscalYearStartMonth')}>
            {(p) => (
              <Select {...p} value={month} onChange={(e) => setMonth(e.target.value)}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            loading={save.isPending}
            disabled={!q.data || month === String(q.data.fiscalYearStartMonth)}
            onClick={() => save.mutate(undefined)}
          >
            Save
          </Button>
        </div>
        <ErrorAlert error={save.error} />
      </QueryState>
    </Card>
  );
}

/** The compound's annual budgets (ADR 0055): drafted here, approved by the board, then spent against. */
export default function BudgetsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const [status, setStatus] = useState<BudgetStatus | ''>('');
  const [drafting, setDrafting] = useState(false);
  const list = useCursorList(keys.budgets(status), (c) => fetchers.budgets(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Budgets" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Budgets"
        description="A budget is in force only once the board approves it; its approval is announced to the owners."
        actions={
          <Button variant="primary" onClick={() => setDrafting(true)}>
            Draft a budget
          </Button>
        }
      />
      <div className="stack">
        <FiscalYearSetting />
        <div className="toolbar">
          <Segmented<BudgetStatus | ''>
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'All' },
              { value: 'draft', label: 'Drafts' },
              { value: 'submitted', label: 'With the board' },
              { value: 'active', label: 'Active' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'withdrawn', label: 'Withdrawn' },
            ]}
          />
        </div>
        <Card flush>
          <QueryState query={list}>
            <DataTable<Budget>
              rows={list.rows}
              rowKey={(b) => b.id}
              empty="No budget yet"
              columns={[
                { key: 'y', header: 'Fiscal year', cell: (b) => <Link href={`/finance/budgets/${b.id}`}>{b.fiscalYear}</Link> },
                { key: 'p', header: 'Period', cell: (b) => `${b.startsOn} – ${b.endsOn}` },
                { key: 't', header: 'Budgeted', cell: (b) => egp(b.totals.budgeted) },
                { key: 'r', header: 'Remaining', cell: (b) => (b.status === 'active' ? egp(b.totals.remaining) : '—') },
                { key: 'c', header: 'Created', cell: (b) => formatDateTime(b.createdAt) },
                { key: 's', header: 'Status', cell: (b) => <StatusBadge status={b.status} /> },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
      </div>
      {drafting ? <Draft budgets={list.rows ?? []} onClose={() => setDrafting(false)} /> : null}
    </>
  );
}
