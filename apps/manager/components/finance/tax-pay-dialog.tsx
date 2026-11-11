'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-tax-pay';
import en from '@/messages/en/fin-tax-pay';
import { amountOk } from './tax';
import { PayoutAccountField } from './payout-account';

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * Tax paid to the tax authority (ADR 0093): a month’s VAT against its
 * declaration, or a quarter’s withholding, from a treasury account of the
 * method’s kind; at most what is still due.
 */
export function TaxPayDialog({
  title,
  due,
  what,
  onClose,
}: {
  title: string;
  /** What is still due, EGP. */
  due: string;
  what: { kind: 'vat'; declarationId: string } | { kind: 'withholding'; quarter: string };
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [amount, setAmount] = useState(due);
  const [paidOn, setPaidOn] = useState(today());
  const [method, setMethod] = useState<'bank_transfer' | 'cheque' | 'cash'>('bank_transfer');
  const [account, setAccount] = useState('');
  const [reference, setReference] = useState('');
  const pay = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/tax/payments', {
          body: {
            ...(what.kind === 'vat' ? { kind: 'vat' as const, declarationId: what.declarationId } : { kind: 'withholding' as const, quarter: what.quarter }),
            amount: amount.trim(),
            paidOn,
            method,
            cashAccountId: account,
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.taxAll, keys.glAll, ['finance', 'cash-accounts']],
      onDone: (p) => {
        toast.show(t('done', { number: p.number }));
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(pay.error, f);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={t(what.kind === 'vat' ? 'dueVat' : 'dueWithholding', { amount: f.money(due) })}
      onSubmit={() => pay.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={pay.isPending} disabled={!amountOk(amount) || !account}>
            {t('pay')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('amount')} error={err('amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label={t('paidOn')} error={err('paidOn')}>
            {(p) => <Input {...p} type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('method')} error={err('method')}>
          {(p) => (
            <Select
              {...p}
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as typeof method);
                setAccount('');
              }}
            >
              <option value="bank_transfer">{label('bank_transfer')}</option>
              <option value="cheque">{label('cheque')}</option>
              <option value="cash">{label('cash')}</option>
            </Select>
          )}
        </Field>
        <PayoutAccountField method={method} value={account} onChange={setAccount} error={pay.error} />
        <Field label={t('reference')} error={err('reference')}>
          {(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <ErrorAlert error={pay.error} />
      </div>
    </Dialog>
  );
}
