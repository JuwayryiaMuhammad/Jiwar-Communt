'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, ReasonCodeDialog, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Compensation } from '@/lib/queries';

/**
 * The manager's decision on a compensation (ADR 0082), once. A credit names
 * the unit's invoice the credit note is issued on; above the board's binding
 * limit (`authority.decider` is `board`) it also names what the board
 * approved, raised as a `compensation_above_limit` request beforehand.
 */
export function CompensationDecision({ compensation: x, unitId }: { compensation: Compensation; unitId: string }) {
  const toast = useToast();
  const [open, setOpen] = useState<'approve' | 'reject' | null>(null);
  const [invoiceId, setInvoiceId] = useState('');
  const [authorizationId, setAuthorizationId] = useState('');
  const refresh = { invalidate: [keys.experienceAll] };
  const path = { path: { id: x.id } };
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/compensations/{id}/decide', {
          params: path,
          body: {
            decision: 'approve',
            ...(x.kind === 'credit' ? { invoiceId } : {}),
            ...(authorizationId ? { authorizationId } : {}),
          },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(x.kind === 'credit' ? 'Approved: the credit note is issued and the unit told.' : 'Approved.');
        setOpen(null);
      },
    },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/experience/compensations/{id}/decide', { params: path, body: { decision: 'reject', reasonCode } })),
    {
      ...refresh,
      onDone: () => {
        toast.show('Rejected.');
        setOpen(null);
      },
    },
  );
  if (x.status !== 'proposed') return null;
  const board = x.authority?.decider === 'board';
  return (
    <>
      <span className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => setOpen('approve')}>
          {board ? 'Approve with the board’s' : 'Approve'}
        </Button>
        <Button size="sm" onClick={() => setOpen('reject')}>
          Reject
        </Button>
      </span>
      <Dialog
        open={open === 'approve'}
        onClose={() => setOpen(null)}
        title="Approve the compensation"
        description={
          board
            ? `Above the board’s limit (${x.authority?.threshold} EGP): name what the board approved for it. Raise it first from the board’s approvals (type: compensation above limit).`
            : 'Within your limit.'
        }
        onSubmit={(e) => {
          e.preventDefault();
          approve.mutate();
        }}
        footer={
          <Button type="submit" variant="primary" loading={approve.isPending}>
            Approve
          </Button>
        }
      >
        <div className="stack">
          {x.kind === 'credit' ? (
            <Field label="The unit’s invoice" hint={<Link href={`/units/${unitId}`}>Find it on the unit’s statement</Link>}>
              {(p) => <Input {...p} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder="Invoice id" />}
            </Field>
          ) : null}
          {board ? (
            <Field label="The board’s authorization" hint={<Link href="/governance">The board’s approvals</Link>}>
              {(p) => <Input {...p} value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)} />}
            </Field>
          ) : null}
          <ErrorAlert error={approve.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        title="Reject the compensation?"
        codes={REASON_CODES.compensationReject}
        confirmLabel="Reject"
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
    </>
  );
}
