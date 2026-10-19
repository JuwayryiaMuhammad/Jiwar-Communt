'use client';

import { fieldError, formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
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
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { FileUpload } from '@/components/file-upload';
import { CATEGORY_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Expense, type ExpenseAuthorization, type ExpenseFilters } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

function RecordExpense({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const active = useQuery({ queryKey: keys.budgets('active'), queryFn: () => fetchers.budgets('active', undefined, 1) });
  const auths = useQuery({ queryKey: keys.expenseAuthorizations, queryFn: fetchers.expenseAuthorizations });
  const budget = active.data?.data[0];
  const [lineId, setLineId] = useState('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(today());
  const [reference, setReference] = useState('');
  const [authorizationId, setAuthorizationId] = useState('');
  const [invoice, setInvoice] = useState<string | null>(null);
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/expenses', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            budgetLineId: lineId,
            vendor: vendor.trim(),
            amount: amount.trim(),
            spentOn,
            invoiceFileId: invoice ?? '',
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(authorizationId ? { authorizationId } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: (e) => {
        toast.show(`Recorded as ${e.number}.`);
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(record.error, f);
  const open = (auths.data ?? []).filter((a) => Number(a.remaining) > 0);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Record an expense"
      description="Against a line of the active budget, never past what it has left. Above the manager’s limit, name a major contract the board approved."
      onSubmit={() => record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={record.isPending}
            disabled={!lineId || !vendor.trim() || !amount.trim() || !invoice}
          >
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={budget ? `Line of the ${budget.fiscalYear} budget` : 'Line'} error={err('budgetLineId')}>
          {(p) => (
            <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">{active.isPending ? 'Loading…' : budget ? 'Choose a line' : 'No active budget'}</option>
              {(budget?.lines ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {CATEGORY_TEXT[l.category]} · {egp(l.remaining)} left
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Vendor" error={err('vendor')}>
          {(p) => <Input {...p} maxLength={200} value={vendor} onChange={(e) => setVendor(e.target.value)} />}
        </Field>
        <div className="row" style={{ gap: 16 }}>
          <Field label="Amount (EGP)" error={err('amount')}>
            {(p) => <Input {...p} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Spent on" error={err('spentOn')}>
            {(p) => <Input {...p} type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />}
          </Field>
        </div>
        <Field label="Reference (optional)" error={err('reference')}>
          {(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <Field label="Major contract (above the manager’s limit)" error={err('authorizationId')}>
          {(p) => (
            <Select {...p} value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)}>
              <option value="">None</option>
              {open.map((a) => (
                <option key={a.id} value={a.id}>
                  Approved {formatDate(a.createdAt)} · {egp(a.remaining)} left of {egp(a.amount)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {invoice ? <p className="t-secondary">The invoice is attached.</p> : null}
        <FileUpload purpose="expense_invoice" label="Attach the invoice" onUploaded={setInvoice} disabled={invoice !== null} />
        {err('invoiceFileId') ? <p className="t-error">{err('invoiceFileId')}</p> : null}
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

/** Expenses against the budget (ADR 0055), each with its invoice; voided once, never edited. */
export default function ExpensesPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const [filters, setFilters] = useState<ExpenseFilters>({});
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const list = useCursorList(keys.expenses(filters), (c) => fetchers.expenses(filters, c), { enabled: allowed });
  const auths = useQuery({ queryKey: keys.expenseAuthorizations, queryFn: fetchers.expenseAuthorizations, enabled: allowed });
  const voidIt = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/expenses/{id}/void', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.budgetsAll],
      onDone: () => {
        toast.show('Voided: its line has the money again.');
        setVoiding(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Expenses" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Expenses"
        description="What the compound spent, against the active budget’s lines."
        actions={
          <Button variant="primary" onClick={() => setRecording(true)}>
            Record an expense
          </Button>
        }
      />
      <div className="stack">
        <div className="toolbar">
          <Field label="From">
            {(p) => <Input {...p} type="date" value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })} />}
          </Field>
          <Field label="To">
            {(p) => <Input {...p} type="date" value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })} />}
          </Field>
        </div>
        <Card flush>
          <QueryState query={list}>
            <DataTable<Expense>
              rows={list.rows}
              rowKey={(e) => e.id}
              empty="No expense yet"
              columns={[
                { key: 'n', header: 'Number', cell: (e) => <span className="t-mono">{e.number}</span> },
                { key: 'd', header: 'Spent on', cell: (e) => formatDate(e.spentOn) },
                { key: 'c', header: 'Line', cell: (e) => `${CATEGORY_TEXT[e.category]} · ${e.fiscalYear}` },
                { key: 'v', header: 'Vendor', cell: (e) => e.vendor },
                { key: 'a', header: 'Amount', cell: (e) => egp(e.amount) },
                { key: 'r', header: 'Reference', cell: (e) => e.reference ?? '—' },
                {
                  key: 'i',
                  header: 'Invoice',
                  cell: (e) =>
                    e.invoiceUrl ? (
                      <a href={e.invoiceUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 's',
                  header: 'Status',
                  cell: (e) =>
                    e.voided ? (
                      <>
                        <StatusBadge status="voided" /> {humanize(e.voided.reasonCode)}
                      </>
                    ) : (
                      <StatusBadge status="recorded" />
                    ),
                },
                {
                  key: 'x',
                  header: '',
                  cell: (e) =>
                    e.voided ? null : (
                      <Button variant="text" onClick={() => setVoiding(e)}>
                        Void
                      </Button>
                    ),
                },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title="Major contracts">
            <span className="t-secondary">Approved by the board; spent down by the expenses that name them.</span>
          </CardHeader>
          <QueryState query={auths}>
            <DataTable<ExpenseAuthorization>
              rows={auths.data ?? []}
              rowKey={(a) => a.id}
              empty="None approved"
              columns={[
                { key: 'd', header: 'Approved', cell: (a) => formatDateTime(a.createdAt) },
                {
                  key: 'r',
                  header: 'Request',
                  cell: (a) => (can('governance.approvals') ? <Link href={`/governance/approvals/${a.approvalRequestId}`}>Open</Link> : '—'),
                },
                { key: 'a', header: 'Amount', cell: (a) => egp(a.amount) },
                { key: 's', header: 'Spent', cell: (a) => egp(a.spent) },
                { key: 'l', header: 'Left', cell: (a) => egp(a.remaining) },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {recording ? <RecordExpense onClose={() => setRecording(false)} /> : null}
      <ReasonCodeDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title={voiding ? `Void ${voiding.number}?` : 'Void the expense?'}
        description="Once: it stays on the record as voided, and its line has the money again."
        codes={REASON_CODES.expenseVoid}
        confirmLabel="Void"
        danger
        pending={voidIt.isPending}
        error={<ErrorAlert error={voidIt.error} />}
        onConfirm={(reasonCode) => voiding && voidIt.mutate({ id: voiding.id, reasonCode })}
      />
    </>
  );
}
