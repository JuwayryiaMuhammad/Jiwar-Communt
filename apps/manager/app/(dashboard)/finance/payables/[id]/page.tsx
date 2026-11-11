'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, Input, PageHeader, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { useFinanceCode } from '@/components/finance/codes';
import { PayoutAccountField } from '@/components/finance/payout-account';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorInvoice } from '@/lib/queries';
import ar from '@/messages/ar/fin-payable-invoice';
import en from '@/messages/en/fin-payable-invoice';

const today = () => new Date().toLocaleDateString('en-CA');

function Decide({ i }: { i: VendorInvoice }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const code = useFinanceCode();
  const toast = useToast();
  const { can } = usePermissions();
  const path = { params: { path: { id: i.id } } };
  const [key] = useState(() => crypto.randomUUID());
  const [asking, setAsking] = useState<'reject' | 'cancel' | null>(null);
  const [paidOn, setPaidOn] = useState(today());
  const [method, setMethod] = useState<'bank_transfer' | 'cheque' | 'cash'>('bank_transfer');
  const [reference, setReference] = useState('');
  const [setOff, setSetOff] = useState('');
  const [account, setAccount] = useState('');
  const done = { invalidate: [keys.payablesAll, keys.budgetsAll] };
  const close = useAction(
    (v: { to: 'reject' | 'cancel'; reasonCode: string }) =>
      unwrap(
        v.to === 'reject'
          ? api.POST('/api/v1/staff/finance/vendor-invoices/{id}/reject', { ...path, body: { reasonCode: v.reasonCode } })
          : api.POST('/api/v1/staff/finance/vendor-invoices/{id}/cancel', { ...path, body: { reasonCode: v.reasonCode } }),
      ),
    {
      ...done,
      onDone: () => {
        toast.show(asking === 'reject' ? t('rejected', { number: i.number }) : t('cancelled', { number: i.number }));
        setAsking(null);
      },
    },
  );
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/finance/vendor-invoices/{id}/approve', { ...path, body: {} })), {
    ...done,
    onDone: () => toast.show(t('approved', { number: i.number })),
  });
  const pay = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/vendor-invoices/{id}/pay', {
          ...path,
          params: { ...path.params, header: { 'Idempotency-Key': key } },
          body: {
            paidOn,
            method,
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(setOff.trim() ? { advanceSetOff: setOff.trim() } : {}),
            ...(account ? { cashAccountId: account } : {}),
          },
        }),
      ),
    {
      invalidate: [...done.invalidate, ['finance', 'cash-accounts']],
      onDone: (r) => toast.show(t('paid', { payout: r.payout?.number ?? '' })),
    },
  );
  return (
    <>
      <ErrorAlert error={approve.error ?? pay.error} />
      {i.status === 'received' && can('finance.payables_approve') ? (
        i.recordedByMe ? (
          <p className="t-secondary">{t('recordedByYou')}</p>
        ) : (
          <>
            <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
              {c('approve')}
            </Button>{' '}
            <Button onClick={() => setAsking('reject')}>{t('turnDown')}</Button>
          </>
        )
      ) : null}
      {i.status === 'approved' && can('finance.payables') ? (
        <div className="form">
          <div className="row" style={{ gap: 16 }}>
            <Field label={t('paidOn')}>{(p) => <Input {...p} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
            <Field label={t('how')}>
              {(p) => (
                <Select
                  {...p}
                  value={method}
                  onChange={(e) => {
                    setMethod(e.target.value as typeof method);
                    setAccount('');
                  }}
                >
                  <option value="bank_transfer">{code('method', 'bank_transfer')}</option>
                  <option value="cheque">{code('method', 'cheque')}</option>
                  <option value="cash">{code('method', 'cash')}</option>
                </Select>
              )}
            </Field>
            <PayoutAccountField method={method} value={account} onChange={setAccount} error={pay.error} />
            <Field label={t('reference')}>{(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
            {i.contractId ? (
              <Field label={t('setOff')}>
                {(p) => <Input {...p} inputMode="decimal" value={setOff} onChange={(e) => setSetOff(e.target.value)} />}
              </Field>
            ) : null}
          </div>
          <Button variant="primary" loading={pay.isPending} onClick={() => pay.mutate()}>
            {t('payOut')}
          </Button>
        </div>
      ) : null}
      {(i.status === 'received' || (i.status === 'approved' && can('finance.payables_approve'))) ? (
        <Button onClick={() => setAsking('cancel')}>{t('callOff')}</Button>
      ) : null}
      <ReasonCodeDialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === 'reject' ? t('rejectTitle', { number: i.number }) : t('cancelTitle', { number: i.number })}
        codes={asking === 'reject' ? REASON_CODES.vendorInvoiceReject : REASON_CODES.vendorInvoiceCancel}
        confirmLabel={asking === 'reject' ? t('turnDown') : t('callOff')}
        danger
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => asking && close.mutate({ to: asking, reasonCode })}
      />
    </>
  );
}

/** A vendor's invoice (ADR 0089): its lines, its decision and its payout. */
export default function VendorInvoicePage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const code = useFinanceCode();
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: keys.vendorInvoice(id), queryFn: () => fetchers.vendorInvoice(id) });
  const i = q.data;
  return (
    <>
      <PageHeader title={i ? `${i.number} · ${i.vendorNumber}` : t('title')} description={i ? label(i.status) : undefined} />
      <QueryState query={q}>
        {i ? (
          <>
            <Card>
              <SectionHeader
                title={
                  Number(i.vatRecoverable) > 0
                    ? t('headlineRecovered', { total: f.money(i.total), tax: f.money(i.tax), recovered: f.money(i.vatRecoverable) })
                    : t('headline', { total: f.money(i.total), tax: f.money(i.tax) })
                }
                description={t('dates', { issued: f.day(i.issuedOn), due: f.day(i.dueOn), recorded: f.dateTime(i.recordedAt) })}
              />
              {i.invoiceUrl ? (
                <a href={i.invoiceUrl} target="_blank" rel="noreferrer">
                  {t('scan')}
                </a>
              ) : null}
              <DataTable
                rows={i.lines}
                rowKey={(l) => String(l.position)}
                columns={[
                  { key: 'd', header: t('line'), cell: (l) => l.description },
                  { key: 'a', header: c('amount'), cell: (l) => f.money(l.amount) },
                  { key: 't', header: t('tax'), cell: (l) => `${t(`tax.${l.taxCode}`)} · ${f.money(l.tax)}` },
                ]}
              />
              <Decide i={i} />
            </Card>
            {i.payout ? (
              <Card>
                <SectionHeader
                  title={t('paidAs', { number: i.payout.number, day: f.day(i.payout.paidOn) })}
                  description={
                    Number(i.payout.withholding) > 0
                      ? t('payoutWithheld', {
                          gross: f.money(i.payout.gross),
                          held: f.money(i.payout.retentionHeld),
                          setOff: f.money(i.payout.advanceSetOff),
                          withheld: f.money(i.payout.withholding),
                          rate: f.percent(Number(i.payout.withholdingRate) / 100, 2),
                          base: f.money(i.payout.withholdingBase),
                          net: f.money(i.payout.net),
                          method: code('method', i.payout.method),
                        })
                      : t('payout', {
                          gross: f.money(i.payout.gross),
                          held: f.money(i.payout.retentionHeld),
                          setOff: f.money(i.payout.advanceSetOff),
                          net: f.money(i.payout.net),
                          method: code('method', i.payout.method),
                        })
                  }
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </QueryState>
    </>
  );
}
