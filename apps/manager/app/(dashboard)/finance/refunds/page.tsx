'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, useCommonT, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Refund } from '@/lib/queries';
import ar from '@/messages/ar/fin-refunds';
import en from '@/messages/en/fin-refunds';

/**
 * Refunds of units' credit (ADR 0048), the manager's alone. A refund is
 * recorded from a unit's statement; a mistaken one is reversed here, and
 * the money is the unit's credit again.
 */
export default function RefundsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const code = useFinanceCode();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.refund');
  const list = useCursorList(keys.refunds({}), (cursor) => fetchers.refunds({}, cursor), { enabled: allowed });
  const [reversing, setReversing] = useState<Refund | null>(null);
  const reverse = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/refunds/{id}/reverse', { params: { path: { id: reversing!.id } }, body: { reasonCode } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (r) => {
        toast.show(t('reversedToast', { number: r.number }));
        setReversing(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Refund>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              { key: 'n', header: t('refund'), cell: (r) => <span className="t-mono ltr">{r.number}</span> },
              {
                key: 'u',
                header: c('unit'),
                cell: (r) => (
                  <Link className="t-mono ltr" href={`/finance/units/${r.unitId}`}>
                    {r.unitCode}
                  </Link>
                ),
              },
              { key: 'a', header: c('amount'), cell: (r) => f.money(r.amount) },
              { key: 'c', header: t('by'), cell: (r) => code('refundChannel', r.channel) },
              { key: 'ref', header: t('reference'), cell: (r) => (r.reference ? <span className="t-mono ltr">{r.reference}</span> : '—') },
              { key: 'd', header: t('refundedOn'), cell: (r) => f.day(r.refundedOn) },
              { key: 'who', header: t('recordedBy'), cell: (r) => r.recordedBy.fullName ?? c('erasedAccount') },
              {
                key: 's',
                header: '',
                cell: (r) =>
                  r.reversal ? (
                    <span title={f.dateTime(r.reversal.createdAt)}>
                      <Badge tone="beige">{t('reversed')}</Badge>
                    </span>
                  ) : (
                    <Button variant="text" onClick={() => setReversing(r)}>
                      {t('reverse')}
                    </Button>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={t('reverseTitle', { number: reversing?.number ?? '' })}
        description={t('reverseDescription')}
        codes={REASON_CODES.refundReverse}
        confirmLabel={t('reverse')}
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reverse.mutate(reasonCode)}
      />
    </>
  );
}
