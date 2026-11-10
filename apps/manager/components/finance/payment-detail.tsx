'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, ReasonCodeDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceCode } from './codes';

/** One payment: its receipt, what it paid, and its reversal (office only). */
export function PaymentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const code = useFinanceCode();
  const toast = useToast();
  const { can } = usePermissions();
  const payment = useQuery({ queryKey: keys.payment(id), queryFn: () => fetchers.payment(id) });
  const [reversing, setReversing] = useState(false);
  const reverse = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/payments/{id}/reverse', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.paymentsAll, keys.invoicesAll],
      onDone: () => {
        toast.show(t('payment.reversedToast'));
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
        title={p ? t('payment.title', { receipt: p.receiptNumber, unit: p.unitCode }) : t('payment.fallback')}
        description={p ? t('payment.description', { method: code('method', p.method), amount: fmt.money(p.amount), paidOn: fmt.day(p.paidOn) }) : undefined}
        footer={
          <>
            {p ? (
              <a className="btn btn--secondary" href={p.receiptUrl} target="_blank" rel="noreferrer">
                {t('payment.publicReceipt')}
              </a>
            ) : null}
            {reversible ? (
              <Button variant="danger" onClick={() => setReversing(true)}>
                {t('payment.reverse')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={payment} rows={4}>
          {p ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('payment.channel')}</dt>
                <dd>{p.channel === 'online' ? t('channel.online') : t('channel.office')}</dd>
                {p.reference ? (
                  <>
                    <dt>{t('payment.reference')}</dt>
                    <dd className="t-mono">{p.reference}</dd>
                  </>
                ) : null}
                <dt>{t('payment.recorded')}</dt>
                <dd>
                  {p.recordedBy
                    ? t('payment.recordedBy', { when: fmt.dateTime(p.createdAt), who: p.recordedBy.fullName ?? c('erasedAccount') })
                    : fmt.dateTime(p.createdAt)}
                </dd>
                <dt>{t('payment.allocated')}</dt>
                <dd>{fmt.money(p.allocated)}</dd>
                {Number(p.unallocated) > 0 ? (
                  <>
                    <dt>{t('payment.credit')}</dt>
                    <dd>{fmt.money(p.unallocated)}</dd>
                  </>
                ) : null}
                {p.reversal ? (
                  <>
                    <dt>{t('reversed')}</dt>
                    <dd>
                      <Badge tone="beige">{label(p.reversal.reasonCode)}</Badge> {fmt.dateTime(p.reversal.createdAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
              <Card flush>
                <DataTable
                  rows={p.allocations}
                  rowKey={(a) => `${a.invoiceId}-${a.amount}`}
                  empty={t('payment.noAllocation')}
                  columns={[
                    { key: 'i', header: t('invoice'), cell: (a) => <span className="t-mono">{a.invoiceNumber}</span> },
                    { key: 'a', header: t('paid'), cell: (a) => fmt.money(a.amount) },
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
        title={t('payment.reverseTitle', { receipt: p?.receiptNumber ?? '' })}
        description={t('payment.reverseDescription')}
        codes={REASON_CODES.paymentReverse}
        confirmLabel={t('payment.reverse')}
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reverse.mutate(reasonCode)}
      />
    </>
  );
}
