'use client';

import { ApiError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, DataTable, ReasonCodeDialog, useCommonT, useToast } from '@jiwar/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys } from '@/lib/queries';
import { wageText } from '@/components/workers/wage-text';
import ar from '@/messages/ar/workers';
import en from '@/messages/en/workers';

type Engagement = Schema<'EngagementDetailView'>;
type Payment = Schema<'WagePaymentView'>;
type ObligationKind = Schema<'WageObligationKind'>;

/**
 * A worker's wage as management reads it (ADR 0037): what the household
 * agreed and the months it recorded as paid. Management never sets a wage or
 * records a payment; it closes the wage obligation an ended engagement
 * leaves open (ADR 0022), which a recorded payment never does.
 */
export function WorkerWages({ engagement }: { engagement: Engagement }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { me, can } = usePermissions();
  // Which open obligation is being closed: each kind closes alone, with its own reasons.
  const [closing, setClosing] = useState<ObligationKind | null>(null);
  // The API gives payments and the closing to manager accounts, whatever a staff role holds.
  const isManager = me?.type === 'manager';
  const path = { path: { id: engagement.id } };

  const payments = useCursorList<Payment>(
    [...keys.engagement(engagement.id), 'wage-payments'],
    (cursor) => unwrap(api.GET('/api/v1/worker-engagements/{id}/wage-payments', { params: { ...path, query: { cursor, limit: 12 } } })),
    { enabled: isManager },
  );

  const settle = useAction(
    (v: { kind: ObligationKind; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/worker-engagements/{id}/wage-obligation/settle', { params: path, body: v })),
    {
      // Closing it may unblock the employer's deletion request.
      invalidate: [keys.engagement(engagement.id), keys.erasures],
      onDone: () => {
        toast.show(t('obligationClosed'));
        setClosing(null);
      },
    },
  );

  // Someone else closed it meanwhile: the refusal stays in the dialog, the page behind it catches up.
  const client = useQueryClient();
  const gone = settle.error instanceof ApiError && settle.error.code === 'WAGE_OBLIGATION_NOT_OPEN';
  useEffect(() => {
    if (gone) void client.invalidateQueries({ queryKey: keys.engagement(engagement.id) });
  }, [gone, client, engagement.id]);

  const open = engagement.openWageObligations;
  return (
    <div className="stack stack--sm" style={{ borderTop: '1px solid var(--hairline-soft)', paddingTop: 16 }}>
      <strong>{t('wage')}</strong>
      <p>
        {engagement.monthlyWage === null ? (
          <span className="t-secondary">{t('noWage')}</span>
        ) : (
          t('perMonth', { wage: wageText(f, engagement.monthlyWage, engagement.currency) })
        )}
      </p>
      {open.includes('settle_before_close') ? (
        <Alert tone="warn">
          <div className="stack stack--sm">
            <span>{t('settleOpen')}</span>
            {isManager && can('workers.review') ? (
              <span>
                <Button
                  size="sm"
                  onClick={() => {
                    settle.reset();
                    setClosing('settle_before_close');
                  }}
                >
                  {t('closeObligation')}
                </Button>
              </span>
            ) : null}
          </div>
        </Alert>
      ) : null}
      {open.includes('pay_in_full') ? (
        <Alert tone="warn">
          <div className="stack stack--sm">
            <span>{t('payInFullOpen')}</span>
            {isManager && can('workers.review') ? (
              <span>
                <Button
                  size="sm"
                  onClick={() => {
                    settle.reset();
                    setClosing('pay_in_full');
                  }}
                >
                  {t('closeOwedInFull')}
                </Button>
              </span>
            ) : null}
          </div>
        </Alert>
      ) : null}
      {isManager ? (
        <QueryState query={payments} rows={2}>
          <DataTable<Payment>
            rows={payments.rows}
            rowKey={(p) => p.id}
            empty={t('noPayments')}
            columns={[
              { key: 'period', header: t('month'), cell: (p) => f.month(p.period) },
              { key: 'amount', header: c('amount'), cell: (p) => <span className="t-num">{wageText(f, p.amount, p.currency)}</span> },
              { key: 'at', header: t('recorded'), cell: (p) => f.dateTime(p.paidAt) },
              { key: 'by', header: c('by'), cell: (p) => (p.paidBy.erased ? c('erasedAccount') : p.paidBy.fullName) },
            ]}
          />
          <LoadMore query={payments} />
        </QueryState>
      ) : null}
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={
          closing === 'pay_in_full'
            ? t('closePayInFullTitle', { name: engagement.worker.fullName })
            : t('closeSettleTitle', { name: engagement.worker.fullName })
        }
        description={
          closing === 'pay_in_full'
            ? t('closePayInFullDescription')
            : t('closeSettleDescription')
        }
        codes={closing === 'pay_in_full' ? REASON_CODES.wageObligationPayInFull : REASON_CODES.wageObligationSettle}
        codeLabel={t('howYouKnow')}
        confirmLabel={t('closeObligationConfirm')}
        pending={settle.isPending}
        error={<ErrorAlert error={settle.error} />}
        onConfirm={(reasonCode) => closing && settle.mutate({ kind: closing, reasonCode })}
      />
    </div>
  );
}
