'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Checkbox, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceCode } from './codes';
import { needsReference, OFFICE_METHODS, validMoney, validReference } from './logic';

type Method = (typeof OFFICE_METHODS)[number];
const day = (n = 0) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

/**
 * A payment made at the office (ADR 0046): at most what the unit owes (or
 * what the invoices picked owe); it pays the oldest due first. A receipt is
 * issued; a wrong record is reversed, never edited.
 */
export function RecordPaymentDialog({ unitId: fixedUnit, onClose }: { unitId?: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const code = useFinanceCode();
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
        toast.show(t('record.done', { receipt: p.receiptNumber }));
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
      title={t('record.title')}
      description={t('record.description')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('record.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        {fixedUnit ? null : (
          <Field label={c('unit')}>
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
            {Number(statement.data.credit) > 0
              ? t('record.owedCredit', { amount: fmt.money(statement.data.outstanding), credit: fmt.money(statement.data.credit) })
              : t('record.owed', { amount: fmt.money(statement.data.outstanding) })}
          </p>
        ) : null}
        {open.length > 1 ? (
          <Field label={t('record.pick')} hint={t('record.pickHint')}>
            {() => (
              <div className="stack stack--sm">
                {open.map((i) => (
                  <Checkbox
                    key={i.id}
                    label={t('record.invoiceOption', { number: i.number, due: fmt.day(i.dueOn), amount: fmt.money(i.outstanding) })}
                    checked={picked.includes(i.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))}
                  />
                ))}
              </div>
            )}
          </Field>
        ) : null}
        <Field
          label={t('amountEgp')}
          error={
            fieldError(save.error, 'amount') ??
            (amount && validMoney(amount) && Number(amount) > owed ? t('record.atMost', { amount: fmt.money(owed.toFixed(2)) }) : undefined)
          }
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('record.method')}>
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {OFFICE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {code('method', m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {needsReference(method) ? (
          <Field
            label={method === 'cheque' ? t('record.chequeNumber') : t('record.transferReference')}
            error={fieldError(save.error, 'reference') ?? (reference && !validReference(reference) ? t('referenceInvalid') : undefined)}
          >
            {(p) => <Input {...p} maxLength={40} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
        ) : null}
        <Field label={t('record.paidOn')} hint={t('record.paidOnHint')} error={fieldError(save.error, 'paidOn')}>
          {(p) => <Input {...p} type="date" min={day(-31)} max={day()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
