'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, DataTable, Dialog, Field, Input, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InvoiceDetail } from '@/lib/queries';
import { InstalmentsDialog } from './instalments-dialog';
import { creditable, KIND_TEXT, validMoney } from './logic';

function CreditNote({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const toast = useToast();
  const cap = creditable(invoice);
  const [amount, setAmount] = useState(Number(invoice.outstanding) > 0 ? invoice.outstanding : cap);
  const [reasonCode, setReason] = useState('');
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/invoices/{id}/credit-notes', { params: { path: { id: invoice.id } }, body: { amount: amount.trim(), reasonCode } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (n) => {
        toast.show(
          Number(n.released) > 0
            ? `Credit note ${n.number}: ${egp(n.amount)} off ${invoice.number}; ${egp(n.released)} of paid money is the unit’s credit now.`
            : `Credit note ${n.number}: ${egp(n.amount)} off ${invoice.number}.`,
        );
        onClose();
      },
    },
  );
  const ready = validMoney(amount) && Number(amount) <= Number(cap) && reasonCode !== '';
  const releases = validMoney(amount) && Number(amount) > Number(invoice.outstanding);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Credit note on ${invoice.number}`}
      description={`It takes an amount off the invoice, at most ${egp(cap)}. Beyond what it still owes (${egp(invoice.outstanding)}), paid money goes back to the unit’s credit, newest payment first; it then pays the unit’s other invoices or can be refunded.`}
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
        {releases ? (
          <Alert tone="warn">
            {egp((Number(amount) - Number(invoice.outstanding)).toFixed(2))} of paid money will be released to the unit’s credit.
          </Alert>
        ) : null}
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
  const [splitting, setSplitting] = useState(false);
  const i = invoice.data;
  const disputed = i?.dispute?.status === 'open';
  return (
    <>
      <Dialog
        open={!crediting && !splitting}
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
            {i && can('finance.invoice') && !disputed && Number(i.outstanding) > 0 && !i.instalmentPlan && !i.rescheduledBy ? (
              <Button onClick={() => setSplitting(true)}>Split into instalments</Button>
            ) : null}
            {i && can('finance.invoice') && !disputed && Number(creditable(i)) > 0 ? <Button onClick={() => setCrediting(true)}>Credit note</Button> : null}
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
                {i.instalmentPlan ? (
                  <>
                    <dt>Instalment</dt>
                    <dd>
                      {i.instalmentPlan.position} of {i.instalmentPlan.count} ·{' '}
                      <Link className="t-mono" href={`/finance/instalments/${i.instalmentPlan.id}`}>
                        {i.instalmentPlan.number}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {i.rescheduledBy ? (
                  <>
                    <dt>Rescheduled by</dt>
                    <dd>
                      <Link className="t-mono" href={`/finance/instalments/${i.rescheduledBy.id}`}>
                        {i.rescheduledBy.number}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {i.dispute ? (
                  <>
                    <dt>Dispute</dt>
                    <dd>
                      <StatusBadge status={i.dispute.status} />{' '}
                      <Link href={`/finance/disputes?open=${i.dispute.id}`}>Open</Link>
                      {disputed ? ' · frozen until decided' : ''}
                    </dd>
                  </>
                ) : null}
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
                      { key: 'rel', header: 'Released', cell: (n) => (Number(n.released) > 0 ? egp(n.released) : '—') },
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
                      { key: 'rel', header: 'Released', cell: (a) => (Number(a.released) > 0 ? egp(a.released) : '—') },
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
      {splitting && i ? <InstalmentsDialog invoice={i} onClose={() => setSplitting(false)} /> : null}
    </>
  );
}
