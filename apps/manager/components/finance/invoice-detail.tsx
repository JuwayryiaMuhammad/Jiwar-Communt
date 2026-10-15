'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InvoiceDetail } from '@/lib/queries';
import { KIND_TEXT, validMoney } from './logic';

function CreditNote({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(invoice.outstanding);
  const [reasonCode, setReason] = useState('');
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/invoices/{id}/credit-notes', { params: { path: { id: invoice.id } }, body: { amount: amount.trim(), reasonCode } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (n) => {
        toast.show(`Credit note ${n.number}: ${egp(n.amount)} off ${invoice.number}.`);
        onClose();
      },
    },
  );
  const ready = validMoney(amount) && Number(amount) <= Number(invoice.outstanding) && reasonCode !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Credit note on ${invoice.number}`}
      description={`It takes an amount off what the invoice asks for, at most ${egp(invoice.outstanding)}. A paid amount is not credited: it is refunded.`}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Issue credit note
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Amount, EGP" error={fieldError(save.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Reason" error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.creditNote.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** One invoice: its lines, credit notes and the payments that paid it. */
export function InvoiceDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = usePermissions();
  const invoice = useQuery({ queryKey: keys.invoice(id), queryFn: () => fetchers.invoice(id) });
  const [crediting, setCrediting] = useState(false);
  const i = invoice.data;
  return (
    <>
      <Dialog
        open={!crediting}
        wide
        onClose={onClose}
        title={i ? `${i.number} · unit ${i.unitCode}` : 'Invoice'}
        description={i ? `${KIND_TEXT[i.kind] ?? i.kind} · issued ${i.issuedOn} · due ${i.dueOn}` : undefined}
        footer={
          <>
            {i ? (
              <Link className="btn btn--secondary" href={`/finance/units/${i.unitId}`}>
                Unit statement
              </Link>
            ) : null}
            {i && can('finance.invoice') && Number(i.outstanding) > 0 ? <Button onClick={() => setCrediting(true)}>Credit note</Button> : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={invoice} rows={4}>
          {i ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={i.status} />
                </dd>
                <dt>Total</dt>
                <dd>{egp(i.total)}</dd>
                <dt>Credited</dt>
                <dd>{egp(i.credited)}</dd>
                <dt>Paid</dt>
                <dd>{egp(i.paid)}</dd>
                <dt>Owed</dt>
                <dd>
                  <strong>{egp(i.outstanding)}</strong>
                </dd>
                {i.plan ? (
                  <>
                    <dt>Billing period</dt>
                    <dd>
                      {i.plan.periodStartsOn} → {i.plan.periodEndsOn}
                    </dd>
                  </>
                ) : null}
              </dl>
              <Card flush>
                <DataTable
                  rows={i.lines}
                  rowKey={(l) => String(l.position)}
                  empty="No line"
                  columns={[
                    { key: 'en', header: 'Line', cell: (l) => l.descriptionEn },
                    { key: 'ar', header: 'Arabic', cell: (l) => <span dir="rtl" lang="ar">{l.descriptionAr}</span> },
                    { key: 'amount', header: 'Amount', cell: (l) => egp(l.amount) },
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
                      { key: 'n', header: 'Credit note', cell: (n) => <span className="t-mono">{n.number}</span> },
                      { key: 'r', header: 'Reason', cell: (n) => humanize(n.reasonCode) },
                      { key: 'a', header: 'Amount', cell: (n) => egp(n.amount) },
                      { key: 'w', header: 'When', cell: (n) => formatDateTime(n.createdAt) },
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
                      { key: 'r', header: 'Receipt', cell: (a) => <span className="t-mono">{a.receiptNumber}</span> },
                      { key: 'a', header: 'Paid', cell: (a) => egp(a.amount) },
                      { key: 's', header: '', cell: (a) => (a.reversed ? <Badge tone="beige">Reversed</Badge> : null) },
                      { key: 'w', header: 'When', cell: (a) => formatDateTime(a.createdAt) },
                    ]}
                  />
                </Card>
              ) : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {crediting && i ? <CreditNote invoice={i} onClose={() => setCrediting(false)} /> : null}
    </>
  );
}
