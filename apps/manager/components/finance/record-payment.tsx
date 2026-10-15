'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import { METHOD_TEXT, needsReference, validMoney, validReference } from './logic';

type Method = 'cash' | 'bank_transfer' | 'cheque';
const day = (n = 0) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

/**
 * A payment made at the office (ADR 0046): at most what the unit owes (or
 * what the invoices picked owe); it pays the oldest due first. A receipt is
 * issued; a wrong record is reversed, never edited.
 */
export function RecordPaymentDialog({ unitId: fixedUnit, onClose }: { unitId?: string; onClose: () => void }) {
  const toast = useToast();
  const [unitId, setUnitId] = useState(fixedUnit ?? '');
  const statement = useQuery({ queryKey: keys.statement(unitId), queryFn: () => fetchers.statement(unitId), enabled: unitId !== '' });
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(day());
  const [picked, setPicked] = useState<string[]>([]);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/payments', {
          params: { path: { unitId } },
          body: {
            amount: amount.trim(),
            method,
            ...(needsReference(method) ? { reference: reference.trim() } : {}),
            paidOn,
            ...(picked.length ? { invoiceIds: picked } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.paymentsAll, keys.invoicesAll],
      onDone: (p) => {
        toast.show(`Recorded. Receipt ${p.receiptNumber}; the unit is told.`);
        onClose();
      },
    },
  );
  const open = statement.data?.openInvoices ?? [];
  const owed = picked.length
    ? open.filter((i) => picked.includes(i.id)).reduce((s, i) => s + Number(i.outstanding), 0)
    : Number(statement.data?.outstanding ?? 0);
  const ready =
    unitId !== '' &&
    validMoney(amount) &&
    Number(amount) <= owed + 1e-9 &&
    paidOn !== '' &&
    (!needsReference(method) || validReference(reference));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record a payment made at the office"
      description="Cash, a bank transfer or a cheque. At most what is owed: the office never takes credit."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="form">
        {fixedUnit ? null : (
          <Field label="Unit">
            {(p) => (
              <UnitPicker
                {...p}
                value={unitId}
                onChange={(e) => {
                  setUnitId(e.target.value);
                  setPicked([]);
                }}
              />
            )}
          </Field>
        )}
        {statement.data ? (
          <p className="t-secondary">
            Owed: {egp(statement.data.outstanding)}
            {Number(statement.data.credit) > 0 ? ` · credit ${egp(statement.data.credit)}` : ''}
          </p>
        ) : null}
        {open.length > 1 ? (
          <Field label="Pay these invoices" hint="None picked: the oldest due first.">
            {() => (
              <div className="stack stack--sm">
                {open.map((i) => (
                  <Checkbox
                    key={i.id}
                    label={`${i.number} · due ${i.dueOn} · owes ${egp(i.outstanding)}`}
                    checked={picked.includes(i.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))}
                  />
                ))}
              </div>
            )}
          </Field>
        ) : null}
        <Field
          label="Amount, EGP"
          error={fieldError(save.error, 'amount') ?? (amount && validMoney(amount) && Number(amount) > owed ? `At most ${egp(owed.toFixed(2))}.` : undefined)}
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Method">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {(['cash', 'bank_transfer', 'cheque'] as const).map((m) => (
                <option key={m} value={m}>
                  {METHOD_TEXT[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {needsReference(method) ? (
          <Field label={method === 'cheque' ? 'Cheque number' : 'Transfer reference'} error={fieldError(save.error, 'reference') ?? (reference && !validReference(reference) ? 'Letters, digits, / and - only.' : undefined)}>
            {(p) => <Input {...p} maxLength={40} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Paid on" hint="Today or up to 31 days ago." error={fieldError(save.error, 'paidOn')}>
          {(p) => <Input {...p} type="date" min={day(-31)} max={day()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
