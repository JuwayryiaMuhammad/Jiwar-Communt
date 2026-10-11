'use client';

import { ApiError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Alert, Button, DataTable, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys } from '@/lib/queries';

type Engagement = Schema<'EngagementDetailView'>;
type Payment = Schema<'WagePaymentView'>;

const amountFormat = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "3200.00" → "3,200.00": the compound's currency, which the API does not name. */
export function wageText(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = Number(amount);
  return Number.isFinite(n) ? amountFormat.format(n) : amount;
}

/** "2026-09" → "September 2026". */
export function periodText(period: string): string {
  const d = new Date(`${period}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? period : monthFormat.format(d);
}

/**
 * A worker's wage as management reads it (ADR 0037): what the household
 * agreed and the months it recorded as paid. Management never sets a wage or
 * records a payment; it closes the wage obligation an ended engagement
 * leaves open (ADR 0022), which a recorded payment never does.
 */
export function WorkerWages({ engagement }: { engagement: Engagement }) {
  const toast = useToast();
  const { me, can } = usePermissions();
  const [closing, setClosing] = useState(false);
  // The API gives payments and the closing to manager accounts, whatever a staff role holds.
  const isManager = me?.type === 'manager';
  const path = { path: { id: engagement.id } };

  const payments = useCursorList<Payment>(
    [...keys.engagement(engagement.id), 'wage-payments'],
    (cursor) => unwrap(api.GET('/api/v1/worker-engagements/{id}/wage-payments', { params: { ...path, query: { cursor, limit: 12 } } })),
    { enabled: isManager },
  );

  const settle = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/worker-engagements/{id}/wage-obligation/settle', { params: path, body: { reasonCode } })),
    {
      // Closing it may unblock the employer's deletion request.
      invalidate: [keys.engagement(engagement.id), keys.erasures],
      onDone: () => {
        toast.show('Wage obligation closed.');
        setClosing(false);
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
      <strong>Wage</strong>
      <p>
        {engagement.monthlyWage === null ? (
          <span className="t-secondary">The household has not set a monthly wage.</span>
        ) : (
          <>
            <span className="t-num">{wageText(engagement.monthlyWage)}</span> per month, as the household set it.
          </>
        )}
      </p>
      {open.includes('settle_before_close') ? (
        <Alert tone="warn">
          <div className="stack stack--sm">
            <span>
              A wage obligation is open: this registration ended and nobody has confirmed the worker was paid. The worker&apos;s file stays
              open, and the employer&apos;s account cannot be deleted, until management closes it. A payment the household records does not
              close it.
            </span>
            {isManager && can('workers.review') ? (
              <span>
                <Button
                  size="sm"
                  onClick={() => {
                    settle.reset();
                    setClosing(true);
                  }}
                >
                  Close wage obligation…
                </Button>
              </span>
            ) : null}
          </div>
        </Alert>
      ) : null}
      {open.includes('pay_in_full') ? (
        <Alert tone="warn">
          The worker is owed their wages in full after an underage report. This obligation cannot be closed from the dashboard, and it keeps the employer&apos;s account from being deleted.
        </Alert>
      ) : null}
      {isManager ? (
        <QueryState query={payments} rows={2}>
          <DataTable<Payment>
            rows={payments.rows}
            rowKey={(p) => p.id}
            empty="The household has recorded no wage payment"
            columns={[
              { key: 'period', header: 'Month', cell: (p) => periodText(p.period) },
              { key: 'amount', header: 'Amount', cell: (p) => <span className="t-num">{wageText(p.amount)}</span> },
              { key: 'at', header: 'Recorded', cell: (p) => formatDateTime(p.paidAt) },
              { key: 'by', header: 'By', cell: (p) => (p.paidBy.erased ? 'Erased account' : p.paidBy.fullName) },
            ]}
          />
          <LoadMore query={payments} />
        </QueryState>
      ) : null}
      <ReasonCodeDialog
        open={closing}
        onClose={() => setClosing(false)}
        title={`Close the wage obligation of ${engagement.worker.fullName}?`}
        description="Close it once you know nothing is owed to the worker for this registration. It is recorded with your name and cannot be reopened."
        codes={REASON_CODES.wageObligationSettle}
        codeLabel="How you know"
        confirmLabel="Close obligation"
        pending={settle.isPending}
        error={<ErrorAlert error={settle.error} />}
        onConfirm={(reasonCode) => settle.mutate(reasonCode)}
      />
    </div>
  );
}
