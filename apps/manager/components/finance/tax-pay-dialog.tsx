'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
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
        toast.show(`Recorded as ${p.number}.`);
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
      description={`Still due: ${due} EGP. It leaves a treasury account against ${what.kind === 'vat' ? 'VAT payable' : 'withholding payable'}.`}
      onSubmit={() => pay.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pay.isPending} disabled={!amountOk(amount) || !account}>
            Pay
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label="Amount, EGP" error={err('amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Paid on" error={err('paidOn')}>
            {(p) => <Input {...p} type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} />}
          </Field>
        </div>
        <Field label="Method" error={err('method')}>
          {(p) => (
            <Select
              {...p}
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as typeof method);
                setAccount('');
              }}
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="cheque">Cheque</option>
              <option value="cash">Cash</option>
            </Select>
          )}
        </Field>
        <PayoutAccountField method={method} value={account} onChange={setAccount} error={pay.error} />
        <Field label="The tax authority’s receipt or the transfer’s reference" error={err('reference')}>
          {(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <ErrorAlert error={pay.error} />
      </div>
    </Dialog>
  );
}
