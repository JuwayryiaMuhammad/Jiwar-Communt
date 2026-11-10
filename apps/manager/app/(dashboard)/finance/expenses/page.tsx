'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Expense, type ExpenseAuthorization, type ExpenseFilters } from '@/lib/queries';
import ar from '@/messages/ar/fin-expenses';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/fin-expenses';
import codesEn from '@/messages/en/gov-codes';

const today = () => new Date().toLocaleDateString('en-CA');

function RecordExpense({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
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
        toast.show(t('recordedAs', { number: e.number }));
        onClose();
      },
    },
  );
  const err = (field: string) => fieldError(record.error, field);
  const open = (auths.data ?? []).filter((a) => Number(a.remaining) > 0);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('recordExpense')}
      description={t('recordDescription')}
      onSubmit={() => record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            loading={record.isPending}
            disabled={!lineId || !vendor.trim() || !amount.trim() || !invoice}
          >
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={budget ? t('lineOfBudget', { year: budget.fiscalYear }) : t('line')} error={err('budgetLineId')}>
          {(p) => (
            <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">{active.isPending ? t('loading') : budget ? t('chooseLine') : t('noActiveBudget')}</option>
              {(budget?.lines ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {t('lineLeft', { category: codeText(g, 'category', l.category), amount: f.money(l.remaining) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('col.vendor')} error={err('vendor')}>
          {(p) => <Input {...p} maxLength={200} value={vendor} onChange={(e) => setVendor(e.target.value)} />}
        </Field>
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('amountEgp')} error={err('amount')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label={t('col.spentOn')} error={err('spentOn')}>
            {(p) => <Input {...p} type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('referenceOptional')} error={err('reference')}>
          {(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <Field label={t('majorContract')} error={err('authorizationId')}>
          {(p) => (
            <Select {...p} value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)}>
              <option value="">{t('contractNone')}</option>
              {open.map((a) => (
                <option key={a.id} value={a.id}>
                  {t('contractOption', { day: f.date(a.createdAt), left: f.money(a.remaining), amount: f.money(a.amount) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {invoice ? <p className="t-secondary">{t('invoiceAttached')}</p> : null}
        <FileUpload purpose="expense_invoice" label={t('attachInvoice')} onUploaded={setInvoice} disabled={invoice !== null} />
        {err('invoiceFileId') ? <p className="t-error">{err('invoiceFileId')}</p> : null}
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

/** Expenses against the budget (ADR 0055), each with its invoice; voided once, never edited. */
export default function ExpensesPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const [filters, setFilters] = useState<ExpenseFilters>({});
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const list = useCursorList(keys.expenses(filters), (cursor) => fetchers.expenses(filters, cursor), { enabled: allowed });
  const auths = useQuery({ queryKey: keys.expenseAuthorizations, queryFn: fetchers.expenseAuthorizations, enabled: allowed });
  const voidIt = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/expenses/{id}/void', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.budgetsAll],
      onDone: () => {
        toast.show(t('voidedToast'));
        setVoiding(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setRecording(true)}>
            {t('recordExpense')}
          </Button>
        }
      />
      <div className="stack">
        <div className="toolbar">
          <Field label={c('from')}>
            {(p) => <Input {...p} type="date" value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })} />}
          </Field>
          <Field label={c('to')}>
            {(p) => <Input {...p} type="date" value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })} />}
          </Field>
        </div>
        <Card flush>
          <QueryState query={list}>
            <DataTable<Expense>
              rows={list.rows}
              rowKey={(e) => e.id}
              empty={t('none')}
              columns={[
                { key: 'n', header: t('col.number'), cell: (e) => <span className="t-mono ltr">{e.number}</span> },
                { key: 'd', header: t('col.spentOn'), cell: (e) => f.day(e.spentOn) },
                { key: 'c', header: t('col.line'), cell: (e) => `${codeText(g, 'category', e.category)} · ${e.fiscalYear}` },
                { key: 'v', header: t('col.vendor'), cell: (e) => e.vendor },
                { key: 'a', header: c('amount'), cell: (e) => f.money(e.amount) },
                { key: 'r', header: t('col.reference'), cell: (e) => e.reference ?? '—' },
                {
                  key: 'i',
                  header: t('col.invoice'),
                  cell: (e) =>
                    e.invoiceUrl ? (
                      <a href={e.invoiceUrl} target="_blank" rel="noreferrer">
                        {t('open')}
                      </a>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 's',
                  header: c('status'),
                  cell: (e) =>
                    e.voided ? (
                      <>
                        <StatusBadge status="voided" label={t('voided')} /> {label(e.voided.reasonCode)}
                      </>
                    ) : (
                      <StatusBadge status="recorded" label={t('recorded')} />
                    ),
                },
                {
                  key: 'x',
                  header: '',
                  cell: (e) =>
                    e.voided ? null : (
                      <Button variant="text" onClick={() => setVoiding(e)}>
                        {t('void')}
                      </Button>
                    ),
                },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title={t('contractsTitle')}>
            <span className="t-secondary">{t('contractsHint')}</span>
          </CardHeader>
          <QueryState query={auths}>
            <DataTable<ExpenseAuthorization>
              rows={auths.data ?? []}
              rowKey={(a) => a.id}
              empty={t('noneApproved')}
              columns={[
                { key: 'd', header: t('col.approved'), cell: (a) => f.dateTime(a.createdAt) },
                {
                  key: 'r',
                  header: t('col.request'),
                  cell: (a) => (can('governance.approvals') ? <Link href={`/governance/approvals/${a.approvalRequestId}`}>{t('open')}</Link> : '—'),
                },
                { key: 'a', header: c('amount'), cell: (a) => f.money(a.amount) },
                { key: 's', header: t('col.spent'), cell: (a) => f.money(a.spent) },
                { key: 'l', header: t('col.left'), cell: (a) => f.money(a.remaining) },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {recording ? <RecordExpense onClose={() => setRecording(false)} /> : null}
      <ReasonCodeDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title={voiding ? t('voidTitle', { number: voiding.number }) : t('voidTheExpense')}
        description={t('voidDescription')}
        codes={REASON_CODES.expenseVoid}
        confirmLabel={t('void')}
        danger
        pending={voidIt.isPending}
        error={<ErrorAlert error={voidIt.error} />}
        onConfirm={(reasonCode) => voiding && voidIt.mutate({ id: voiding.id, reasonCode })}
      />
    </>
  );
}
