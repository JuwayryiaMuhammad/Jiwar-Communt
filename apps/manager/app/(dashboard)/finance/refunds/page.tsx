'use client';

import { formatDateTime, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { REFUND_CHANNEL_TEXT } from '@/components/finance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Refund } from '@/lib/queries';

/**
 * Refunds of units' credit (ADR 0048), the manager's alone. A refund is
 * recorded from a unit's statement; a mistaken one is reversed here, and
 * the money is the unit's credit again.
 */
export default function RefundsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.refund');
  const list = useCursorList(keys.refunds({}), (c) => fetchers.refunds({}, c), { enabled: allowed });
  const [reversing, setReversing] = useState<Refund | null>(null);
  const reverse = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/refunds/{id}/reverse', { params: { path: { id: reversing!.id } }, body: { reasonCode } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (r) => {
        toast.show(`Refund ${r.number} reversed: the money is the unit’s credit again.`);
        setReversing(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Refunds" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Refunds" description="Credit paid back to units. To refund one, open its statement and choose “Refund credit”." />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Refund>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No refund yet"
            columns={[
              { key: 'n', header: 'Refund', cell: (r) => <span className="t-mono">{r.number}</span> },
              {
                key: 'u',
                header: 'Unit',
                cell: (r) => (
                  <Link className="t-mono" href={`/finance/units/${r.unitId}`}>
                    {r.unitCode}
                  </Link>
                ),
              },
              { key: 'a', header: 'Amount', cell: (r) => egp(r.amount) },
              { key: 'c', header: 'By', cell: (r) => REFUND_CHANNEL_TEXT[r.channel] ?? r.channel },
              { key: 'ref', header: 'Reference', cell: (r) => (r.reference ? <span className="t-mono">{r.reference}</span> : '—') },
              { key: 'd', header: 'Paid back on', cell: (r) => r.refundedOn },
              { key: 'who', header: 'Recorded by', cell: (r) => r.recordedBy.fullName ?? 'An erased account' },
              {
                key: 's',
                header: '',
                cell: (r) =>
                  r.reversal ? (
                    <span title={formatDateTime(r.reversal.createdAt)}>
                      <Badge tone="beige">Reversed</Badge>
                    </span>
                  ) : (
                    <Button variant="text" onClick={() => setReversing(r)}>
                      Reverse
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
        title={`Reverse refund ${reversing?.number ?? ''}?`}
        description="A new record undoes it; nothing is edited. The money is the unit’s credit again and pays what it owes."
        codes={REASON_CODES.refundReverse}
        confirmLabel="Reverse"
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reverse.mutate(reasonCode)}
      />
    </>
  );
}
