'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, DataTable, Dialog, Field, Input, Select, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InvoiceDetail } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceCode } from './codes';
import { InstalmentsDialog } from './instalments-dialog';
import { creditable, validMoney } from './logic';

function CreditNote({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const cap = creditable(invoice);
  const [amount, setAmount] = useState(Number(invoice.outstanding) > 0 ? invoice.outstanding : cap);
  const [reasonCode, setReason] = useState('');
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/invoices/{id}/credit-notes', { params: { path: { id: invoice.id } }, body: { amount: amount.trim(), reasonCode } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (n) => {
        const params = { number: n.number, amount: fmt.money(n.amount), invoice: invoice.number, released: fmt.money(n.released) };
        toast.show(Number(n.released) > 0 ? t('credit.doneReleased', params) : t('credit.done', params));
        onClose();
      },
    },
  );
  const ready = validMoney(amount) && Number(amount) <= Number(cap) && reasonCode !== '';
  const releases = validMoney(amount) && Number(amount) > Number(invoice.outstanding);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('credit.title', { number: invoice.number })}
      description={t('credit.description', { cap: fmt.money(cap), owed: fmt.money(invoice.outstanding) })}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('credit.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('amountEgp')} error={fieldError(save.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={c('reason')} error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              <option value="">{c('select')}</option>
              {REASON_CODES.creditNote.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {releases ? <Alert tone="warn">{t('credit.releases', { amount: fmt.money((Number(amount) - Number(invoice.outstanding)).toFixed(2)) })}</Alert> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** One invoice: its lines, credit notes and the payments that paid it. */
export function InvoiceDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const code = useFinanceCode();
  const { can } = usePermissions();
  const invoice = useQuery({ queryKey: keys.invoice(id), queryFn: () => fetchers.invoice(id) });
  const [crediting, setCrediting] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const i = invoice.data;
  const disputed = i?.dispute?.status === 'open';
  return (
    <>
      <Dialog
        open={!crediting && !splitting}
        wide
        onClose={onClose}
        title={i ? t('invoice.title', { number: i.number, unit: i.unitCode }) : t('invoice')}
        description={i ? t('invoice.description', { kind: code('kind', i.kind), issued: fmt.day(i.issuedOn), due: fmt.day(i.dueOn) }) : undefined}
        footer={
          <>
            {i ? (
              <Link className="btn btn--secondary" href={`/finance/units/${i.unitId}`}>
                {t('invoice.statement')}
              </Link>
            ) : null}
            {i && can('finance.invoice') && !disputed && Number(i.outstanding) > 0 && !i.instalmentPlan && !i.rescheduledBy ? (
              <Button onClick={() => setSplitting(true)}>{t('invoice.split')}</Button>
            ) : null}
            {i && can('finance.invoice') && !disputed && Number(creditable(i)) > 0 ? <Button onClick={() => setCrediting(true)}>{t('creditNote')}</Button> : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={invoice} rows={4}>
          {i ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={i.status} />
                </dd>
                <dt>{c('total')}</dt>
                <dd>{fmt.money(i.total)}</dd>
                <dt>{t('invoice.credited')}</dt>
                <dd>{fmt.money(i.credited)}</dd>
                <dt>{t('paid')}</dt>
                <dd>{fmt.money(i.paid)}</dd>
                <dt>{t('owed')}</dt>
                <dd>
                  <strong>{fmt.money(i.outstanding)}</strong>
                </dd>
                {i.instalmentPlan ? (
                  <>
                    <dt>{t('invoice.instalment')}</dt>
                    <dd>
                      {t('invoice.position', { position: i.instalmentPlan.position, count: i.instalmentPlan.count })} ·{' '}
                      <Link className="t-mono" href={`/finance/instalments/${i.instalmentPlan.id}`}>
                        {i.instalmentPlan.number}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {i.rescheduledBy ? (
                  <>
                    <dt>{t('invoice.rescheduledBy')}</dt>
                    <dd>
                      <Link className="t-mono" href={`/finance/instalments/${i.rescheduledBy.id}`}>
                        {i.rescheduledBy.number}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {i.dispute ? (
                  <>
                    <dt>{t('invoice.dispute')}</dt>
                    <dd>
                      <StatusBadge status={i.dispute.status} /> <Link href={`/finance/disputes?open=${i.dispute.id}`}>{c('open')}</Link>
                      {disputed ? ` · ${t('invoice.frozen')}` : ''}
                    </dd>
                  </>
                ) : null}
                {i.plan ? (
                  <>
                    <dt>{t('invoice.period')}</dt>
                    <dd>{t('invoice.periodRange', { from: fmt.day(i.plan.periodStartsOn), to: fmt.day(i.plan.periodEndsOn) })}</dd>
                  </>
                ) : null}
              </dl>
              <Card flush>
                <DataTable
                  rows={i.lines}
                  rowKey={(l) => String(l.position)}
                  empty={t('invoice.noLine')}
                  columns={[
                    {
                      key: 'en',
                      header: t('invoice.line'),
                      cell: (l) => (
                        <span dir="ltr" lang="en">
                          {l.descriptionEn}
                        </span>
                      ),
                    },
                    {
                      key: 'ar',
                      header: t('invoice.arabic'),
                      cell: (l) => (
                        <span dir="rtl" lang="ar">
                          {l.descriptionAr}
                        </span>
                      ),
                    },
                    { key: 'amount', header: c('amount'), cell: (l) => fmt.money(l.amount) },
                  ]}
                />
              </Card>
              {i.creditNotes.length ? (
                <Card flush>
                  <DataTable
                    rows={i.creditNotes}
                    rowKey={(n) => n.id}
                    empty=""
                    columns={[
                      { key: 'n', header: t('creditNote'), cell: (n) => <span className="t-mono">{n.number}</span> },
                      { key: 'r', header: c('reason'), cell: (n) => label(n.reasonCode) },
                      { key: 'a', header: c('amount'), cell: (n) => fmt.money(n.amount) },
                      { key: 'rel', header: t('released'), cell: (n) => (Number(n.released) > 0 ? fmt.money(n.released) : '—') },
                      { key: 'w', header: t('when'), cell: (n) => fmt.dateTime(n.createdAt) },
                    ]}
                  />
                </Card>
              ) : null}
              {i.allocations.length ? (
                <Card flush>
                  <DataTable
                    rows={i.allocations}
                    rowKey={(a) => `${a.paymentId}-${a.createdAt}`}
                    empty=""
                    columns={[
                      { key: 'r', header: t('receipt'), cell: (a) => <span className="t-mono">{a.receiptNumber}</span> },
                      { key: 'a', header: t('paid'), cell: (a) => fmt.money(a.amount) },
                      { key: 'rel', header: t('released'), cell: (a) => (Number(a.released) > 0 ? fmt.money(a.released) : '—') },
                      { key: 's', header: '', cell: (a) => (a.reversed ? <Badge tone="beige">{t('reversed')}</Badge> : null) },
                      { key: 'w', header: t('when'), cell: (a) => fmt.dateTime(a.createdAt) },
                    ]}
                  />
                </Card>
              ) : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {crediting && i ? <CreditNote invoice={i} onClose={() => setCrediting(false)} /> : null}
      {splitting && i ? <InstalmentsDialog invoice={i} onClose={() => setSplitting(false)} /> : null}
    </>
  );
}
