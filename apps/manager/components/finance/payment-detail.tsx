'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import { METHOD_TEXT } from './logic';

/** One payment: its receipt, what it paid, and its reversal (office only). */
export function PaymentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { can } = usePermissions();
  const payment = useQuery({ queryKey: keys.payment(id), queryFn: () => fetchers.payment(id) });
  const [reversing, setReversing] = useState(false);
  const reverse = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/payments/{id}/reverse', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.paymentsAll, keys.invoicesAll],
      onDone: () => {
        toast.show('Reversed. What it paid is owed again; the receipt reads reversed.');
        setReversing(false);
      },
    },
  );
  const p = payment.data;
  const reversible = p && p.channel === 'office' && !p.reversal && can('finance.payments');
  return (
    <>
      <Dialog
        open={!reversing}
        wide
        onClose={onClose}
        title={p ? `Receipt ${p.receiptNumber} · unit ${p.unitCode}` : 'Payment'}
        description={p ? `${METHOD_TEXT[p.method] ?? p.method} · ${egp(p.amount)} · paid on ${p.paidOn}` : undefined}
        footer={
          <>
            {p ? (
              <a className="btn btn--secondary" href={p.receiptUrl} target="_blank" rel="noreferrer">
                The public receipt
              </a>
            ) : null}
            {reversible ? (
              <Button variant="danger" onClick={() => setReversing(true)}>
                Reverse
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={payment} rows={4}>
          {p ? (
            <div className="stack">
              <dl className="dl">
                <dt>Channel</dt>
                <dd>{p.channel === 'online' ? 'Online, through Paymob' : 'At the office'}</dd>
                {p.reference ? (
                  <>
                    <dt>Reference</dt>
                    <dd className="t-mono">{p.reference}</dd>
                  </>
                ) : null}
                <dt>Recorded</dt>
                <dd>
                  {formatDateTime(p.createdAt)}
                  {p.recordedBy ? ` · by ${p.recordedBy.fullName ?? 'an erased account'}` : ''}
                </dd>
                <dt>Paid to invoices</dt>
                <dd>{egp(p.allocated)}</dd>
                {Number(p.unallocated) > 0 ? (
                  <>
                    <dt>Unit’s credit</dt>
                    <dd>{egp(p.unallocated)}</dd>
                  </>
                ) : null}
                {p.reversal ? (
                  <>
                    <dt>Reversed</dt>
                    <dd>
                      <Badge tone="beige">{humanize(p.reversal.reasonCode)}</Badge> {formatDateTime(p.reversal.createdAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
              <Card flush>
                <DataTable
                  rows={p.allocations}
                  rowKey={(a) => `${a.invoiceId}-${a.amount}`}
                  empty="Not paid to any invoice"
                  columns={[
                    { key: 'i', header: 'Invoice', cell: (a) => <span className="t-mono">{a.invoiceNumber}</span> },
                    { key: 'a', header: 'Paid', cell: (a) => egp(a.amount) },
                  ]}
                />
              </Card>
              <ErrorAlert error={reverse.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={reversing}
        onClose={() => setReversing(false)}
        title={`Reverse receipt ${p?.receiptNumber ?? ''}?`}
        description="A new record cancels this one; nothing is edited. What it paid is owed again."
        codes={REASON_CODES.paymentReverse}
        confirmLabel="Reverse"
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reverse.mutate(reasonCode)}
      />
    </>
  );
}
