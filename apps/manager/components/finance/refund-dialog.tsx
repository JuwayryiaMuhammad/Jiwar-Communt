'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceCode } from './codes';
import { REFUND_CHANNELS, validMoney, validReference } from './logic';

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * Refund a unit's credit (ADR 0048): recorded by hand, at most its credit,
 * after a fresh code sent to the manager's email. No money moves through
 * the payment provider: a `gateway_manual` refund was made in its own
 * dashboard first.
 */
export function RefundDialog({ unitId, credit, onClose }: { unitId: string; credit: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const code = useFinanceCode();
  const toast = useToast();
  const [amount, setAmount] = useState(credit);
  const [channel, setChannel] = useState<(typeof REFUND_CHANNELS)[number]>('cash');
  const [reference, setReference] = useState('');
  const [refundedOn, setRefundedOn] = useState(today());
  const [confirming, setConfirming] = useState(false);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/refunds', {
          params: { path: { unitId } },
          body: { amount: amount.trim(), channel, refundedOn, ...(reference.trim() ? { reference: reference.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.invoicesAll],
      onDone: (r) => {
        toast.show(t('refund.done', { number: r.number, amount: fmt.money(r.amount) }));
        onClose();
      },
    },
  );
  const ready = validMoney(amount) && Number(amount) <= Number(credit) && (!reference.trim() || validReference(reference));
  return (
    <>
      <Dialog
        open={!confirming}
        onClose={onClose}
        title={t('refund.title')}
        description={t('refund.description', { amount: fmt.money(credit) })}
        onSubmit={() => ready && setConfirming(true)}
        footer={
          <>
            <Button onClick={onClose}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
              {t('refund.confirm')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('amountEgp')} error={fieldError(save.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label={t('refund.channel')}>
            {(p) => (
              <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                {REFUND_CHANNELS.map((v) => (
                  <option key={v} value={v}>
                    {code('refundChannel', v)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('refund.reference')} hint={t('refund.referenceHint')} error={fieldError(save.error, 'reference')}>
            {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
          <Field label={t('refund.on')} error={fieldError(save.error, 'refundedOn')}>
            {(p) => <Input {...p} type="date" value={refundedOn} onChange={(e) => setRefundedOn(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </Dialog>
      {confirming ? (
        <StepUpDialog
          title={t('refund.stepTitle')}
          description={t('refund.stepDescription')}
          onClose={() => setConfirming(false)}
          onVerified={() => {
            setConfirming(false);
            save.mutate();
          }}
        />
      ) : null}
    </>
  );
}
