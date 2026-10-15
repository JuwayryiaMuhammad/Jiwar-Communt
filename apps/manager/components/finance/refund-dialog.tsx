'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { REFUND_CHANNEL_TEXT, validMoney, validReference } from './logic';

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * Refund a unit's credit (ADR 0048): recorded by hand, at most its credit,
 * after a fresh code sent to the manager's email. No money moves through
 * the payment provider: a `gateway_manual` refund was made in its own
 * dashboard first.
 */
export function RefundDialog({ unitId, credit, onClose }: { unitId: string; credit: string; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(credit);
  const [channel, setChannel] = useState<'cash' | 'bank_transfer' | 'gateway_manual'>('cash');
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
        toast.show(`Refund ${r.number}: ${egp(r.amount)} paid back.`);
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
        title="Refund the unit’s credit"
        description={`It holds ${egp(credit)}. Pay it back first, then record it here.`}
        onSubmit={() => ready && setConfirming(true)}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
              Record refund
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Amount, EGP" error={fieldError(save.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Paid back by">
            {(p) => (
              <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                {Object.entries(REFUND_CHANNEL_TEXT).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference" hint="The transfer’s or the provider’s own, if any." error={fieldError(save.error, 'reference')}>
            {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
          <Field label="Paid back on" error={fieldError(save.error, 'refundedOn')}>
            {(p) => <Input {...p} type="date" value={refundedOn} onChange={(e) => setRefundedOn(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </Dialog>
      {confirming ? (
        <StepUpDialog
          title="Confirm it is you"
          description="A refund pays money out: it is recorded only after a fresh code sent to your email."
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
