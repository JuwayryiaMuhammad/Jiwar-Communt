'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, Input, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { SectionHeader } from '@/components/community/bits';
import { PayoutAccountField } from '@/components/finance/payout-account';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorInvoice } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

function Decide({ i }: { i: VendorInvoice }) {
  const toast = useToast();
  const { can } = usePermissions();
  const path = { params: { path: { id: i.id } } };
  const [key] = useState(() => crypto.randomUUID());
  const [asking, setAsking] = useState<'reject' | 'cancel' | null>(null);
  const [paidOn, setPaidOn] = useState(today());
  const [method, setMethod] = useState<'bank_transfer' | 'cheque' | 'cash'>('bank_transfer');
  const [reference, setReference] = useState('');
  const [setOff, setSetOff] = useState('');
  const [account, setAccount] = useState('');
  const done = { invalidate: [keys.payablesAll, keys.budgetsAll] };
  const close = useAction(
    (v: { to: 'reject' | 'cancel'; reasonCode: string }) =>
      unwrap(
        v.to === 'reject'
          ? api.POST('/api/v1/staff/finance/vendor-invoices/{id}/reject', { ...path, body: { reasonCode: v.reasonCode } })
          : api.POST('/api/v1/staff/finance/vendor-invoices/{id}/cancel', { ...path, body: { reasonCode: v.reasonCode } }),
      ),
    {
      ...done,
      onDone: () => {
        toast.show(`${i.number} is ${asking === 'reject' ? 'turned down' : 'called off'}.`);
        setAsking(null);
      },
    },
  );
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/finance/vendor-invoices/{id}/approve', { ...path, body: {} })), {
    ...done,
    onDone: () => toast.show(`${i.number} is approved: its line keeps the money until it is paid.`),
  });
  const pay = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/vendor-invoices/{id}/pay', {
          ...path,
          params: { ...path.params, header: { 'Idempotency-Key': key } },
          body: {
            paidOn,
            method,
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(setOff.trim() ? { advanceSetOff: setOff.trim() } : {}),
            ...(account ? { cashAccountId: account } : {}),
          },
        }),
      ),
    {
      invalidate: [...done.invalidate, ['finance', 'cash-accounts']],
      onDone: (r) => toast.show(`Paid as ${r.payout?.number}; its expense is written and its account moved.`),
    },
  );
  return (
    <>
      <ErrorAlert error={approve.error ?? pay.error} />
      {i.status === 'received' && can('finance.payables_approve') ? (
        i.recordedByMe ? (
          <p className="t-secondary">You recorded it: another approver decides it.</p>
        ) : (
          <>
            <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
              Approve
            </Button>{' '}
            <Button onClick={() => setAsking('reject')}>Turn down</Button>
          </>
        )
      ) : null}
      {i.status === 'approved' && can('finance.payables') ? (
        <div className="form">
          <div className="row" style={{ gap: 16 }}>
            <Field label="Paid on">{(p) => <Input {...p} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
            <Field label="How">
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
            <Field label="Reference">{(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
            {i.contractId ? (
              <Field label="Set off of advances (EGP)">
                {(p) => <Input {...p} inputMode="decimal" value={setOff} onChange={(e) => setSetOff(e.target.value)} />}
              </Field>
            ) : null}
          </div>
          <Button variant="primary" loading={pay.isPending} onClick={() => pay.mutate()}>
            Pay out
          </Button>
        </div>
      ) : null}
      {(i.status === 'received' || (i.status === 'approved' && can('finance.payables_approve'))) ? (
        <Button onClick={() => setAsking('cancel')}>Call off</Button>
      ) : null}
      <ReasonCodeDialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === 'reject' ? `Turn down ${i.number}?` : `Call off ${i.number}?`}
        codes={asking === 'reject' ? REASON_CODES.vendorInvoiceReject : REASON_CODES.vendorInvoiceCancel}
        confirmLabel={asking === 'reject' ? 'Turn down' : 'Call off'}
        danger
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => asking && close.mutate({ to: asking, reasonCode })}
      />
    </>
  );
}

/** A vendor's invoice (ADR 0089): its lines, its decision and its payout. */
export default function VendorInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: keys.vendorInvoice(id), queryFn: () => fetchers.vendorInvoice(id) });
  const i = q.data;
  return (
    <>
      <PageHeader title={i ? `${i.number} · ${i.vendorNumber}` : 'Vendor invoice'} description={i ? humanize(i.status) : undefined} />
      <QueryState query={q}>
        {i ? (
          <>
            <Card>
              <SectionHeader
                title={`${egp(i.total)} (tax ${egp(i.tax)})`}
                description={`Dated ${formatDate(i.issuedOn)}, due ${formatDate(i.dueOn)}; recorded ${formatDateTime(i.recordedAt)}.`}
              />
              {i.invoiceUrl ? (
                <a href={i.invoiceUrl} target="_blank" rel="noreferrer">
                  The scan
                </a>
              ) : null}
              <DataTable
                rows={i.lines}
                rowKey={(l) => String(l.position)}
                columns={[
                  { key: 'd', header: 'Line', cell: (l) => l.description },
                  { key: 'a', header: 'Amount', cell: (l) => egp(l.amount) },
                  { key: 't', header: 'Tax', cell: (l) => `${humanize(l.taxCode)} · ${egp(l.tax)}` },
                ]}
              />
              <Decide i={i} />
            </Card>
            {i.payout ? (
              <Card>
                <SectionHeader
                  title={`Paid as ${i.payout.number} on ${formatDate(i.payout.paidOn)}`}
                  description={`${egp(i.payout.gross)} less ${egp(i.payout.retentionHeld)} held back and ${egp(i.payout.advanceSetOff)} set off: ${egp(i.payout.net)} paid by ${humanize(i.payout.method)}.`}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </QueryState>
    </>
  );
}
