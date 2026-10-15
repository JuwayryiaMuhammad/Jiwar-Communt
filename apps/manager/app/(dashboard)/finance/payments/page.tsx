'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { METHOD_TEXT } from '@/components/finance/logic';
import { PaymentDetailDialog } from '@/components/finance/payment-detail';
import { RecordPaymentDialog } from '@/components/finance/record-payment';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Payment, type PaymentFilters } from '@/lib/queries';

type Channel = 'all' | 'office' | 'online';

/**
 * Payments (ADR 0046): online through Paymob, confirmed by Paymob to the
 * server, and at the office, recorded here; each with its receipt. An
 * office payment recorded by mistake is reversed, never edited.
 */
export default function PaymentsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const [channel, setChannel] = useState<Channel>('all');
  const [method, setMethod] = useState<PaymentFilters['method']>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const filters: PaymentFilters = { channel: channel === 'all' ? '' : channel, method, from, to };
  const list = useCursorList(keys.payments(filters), (c) => fetchers.payments(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Payments" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment pays the oldest invoices due first. Money beyond what a unit owes is its credit, applied to its next invoices."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setRecording(true)}>
            Record a payment
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Channel>
          label="Channel"
          value={channel}
          onChange={setChannel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'office', label: 'At the office' },
            { value: 'online', label: 'Online' },
          ]}
        />
        <Field label="Method">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as PaymentFilters['method'])}>
              <option value="">Any</option>
              {Object.entries(METHOD_TEXT).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Paid from">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="to">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Payment>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No payment matches"
            columns={[
              {
                key: 'receipt',
                header: 'Receipt',
                cell: (p) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(p.id)}>
                    {p.receiptNumber}
                  </Button>
                ),
              },
              {
                key: 'unit',
                header: 'Unit',
                cell: (p) => (
                  <Link className="t-mono" href={`/finance/units/${p.unitId}`}>
                    {p.unitCode}
                  </Link>
                ),
              },
              { key: 'method', header: 'Method', cell: (p) => METHOD_TEXT[p.method] ?? p.method },
              { key: 'amount', header: 'Amount', cell: (p) => egp(p.amount) },
              { key: 'paid', header: 'Paid on', cell: (p) => p.paidOn },
              {
                key: 'state',
                header: '',
                cell: (p) => (p.reversal ? <Badge tone="beige">Reversed</Badge> : Number(p.unallocated) > 0 ? <Badge tone="terracotta">Credit {egp(p.unallocated)}</Badge> : null),
              },
              { key: 'when', header: 'Recorded', cell: (p) => <span title={formatDateTime(p.createdAt)}>{relativeTime(p.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <PaymentDetailDialog id={open} onClose={() => setOpen(null)} /> : null}
      {recording ? <RecordPaymentDialog onClose={() => setRecording(false)} /> : null}
    </>
  );
}
