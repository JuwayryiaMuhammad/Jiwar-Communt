'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { PaymentDetailDialog } from '@/components/finance/payment-detail';
import { RecordPaymentDialog } from '@/components/finance/record-payment';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Payment, type PaymentFilters } from '@/lib/queries';
import ar from '@/messages/ar/fin-payments';
import en from '@/messages/en/fin-payments';

type Channel = 'all' | 'office' | 'online';
const METHODS = ['cash', 'bank_transfer', 'cheque', 'card', 'wallet'] as const;

/**
 * Payments (ADR 0046): online through Paymob, confirmed by Paymob to the
 * server, and at the office, recorded here; each with its receipt. An
 * office payment recorded by mistake is reversed, never edited.
 */
export default function PaymentsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const code = useFinanceCode();
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const [channel, setChannel] = useState<Channel>('all');
  const [method, setMethod] = useState<PaymentFilters['method']>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const filters: PaymentFilters = { channel: channel === 'all' ? '' : channel, method, from, to };
  const list = useCursorList(keys.payments(filters), (cursor) => fetchers.payments(filters, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setRecording(true)}>
            {t('record')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Channel>
          label={t('channel')}
          value={channel}
          onChange={setChannel}
          options={[
            { value: 'all', label: c('all') },
            { value: 'office', label: t('office') },
            { value: 'online', label: t('online') },
          ]}
        />
        <Field label={t('method')}>
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as PaymentFilters['method'])}>
              <option value="">{t('any')}</option>
              {METHODS.map((v) => (
                <option key={v} value={v}>
                  {code('method', v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('paidFrom')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('paidTo')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Payment>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 'receipt',
                header: t('receipt'),
                cell: (p) => (
                  <Button variant="text" className="table__link t-mono ltr" onClick={() => setOpen(p.id)}>
                    {p.receiptNumber}
                  </Button>
                ),
              },
              {
                key: 'unit',
                header: c('unit'),
                cell: (p) => (
                  <Link className="t-mono ltr" href={`/finance/units/${p.unitId}`}>
                    {p.unitCode}
                  </Link>
                ),
              },
              { key: 'method', header: t('method'), cell: (p) => code('method', p.method) },
              { key: 'amount', header: c('amount'), cell: (p) => f.money(p.amount) },
              { key: 'paid', header: t('paidOn'), cell: (p) => f.day(p.paidOn) },
              {
                key: 'state',
                header: '',
                cell: (p) =>
                  p.reversal ? (
                    <Badge tone="beige">{t('reversed')}</Badge>
                  ) : Number(p.unallocated) > 0 ? (
                    <Badge tone="terracotta">{t('credit', { amount: f.money(p.unallocated) })}</Badge>
                  ) : null,
              },
              { key: 'when', header: t('recorded'), cell: (p) => <span title={f.dateTime(p.createdAt)}>{f.relative(p.createdAt)}</span> },
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
