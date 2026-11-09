'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, ConfirmDialog, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Period = Schema<'GlPeriodView'>;

/**
 * Closing months (ADR 0092): a month is closed once it has ended, through
 * it and every open month before it; nothing is then dated in it, and an
 * event of it posts on the next open day. Reopening one is the manager's
 * alone, with a reason, on the record.
 */
export default function ClosingMonthsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const toast = useToast();
  const [closing, setClosing] = useState<Period | null>(null);
  const [reopening, setReopening] = useState<Period | null>(null);
  const periods = useQuery({ queryKey: keys.glPeriods, queryFn: fetchers.glPeriods, enabled: allowed });
  const close = useAction(
    (month: string) => unwrap(api.POST('/api/v1/staff/finance/gl/periods/close', { body: { month } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show('Closed.');
        setClosing(null);
      },
    },
  );
  const reopen = useAction(
    ({ month, reasonCode }: { month: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/gl/periods/reopen', { body: { month, reasonCode } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show('Reopened.');
        setReopening(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Closing months" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Closing months" description="A closed month takes no entry: a correction is a reversing entry in an open month." />
      <QueryState query={periods} rows={6}>
        <Card flush>
          <SectionHeader title="The ledger’s months" description="Newest first, from the first entry’s month." />
          <DataTable<Period>
            rows={periods.data?.data}
            rowKey={(p) => p.month}
            columns={[
              { key: 'm', header: 'Month', cell: (p) => p.month },
              {
                key: 's',
                header: 'Status',
                cell: (p) => (p.status === 'closed' ? <Badge tone="dark">Closed</Badge> : <Badge tone="green">Open</Badge>),
              },
              {
                key: 'c',
                header: 'Closed',
                cell: (p) => (p.closedAt ? `${formatDateTime(p.closedAt)} · ${p.closedBy?.fullName ?? '—'}` : ''),
              },
              {
                key: 'r',
                header: 'Reopened',
                cell: (p) =>
                  p.reopenedAt ? `${formatDateTime(p.reopenedAt)} · ${p.reopenedBy?.fullName ?? '—'} · ${humanize(p.reopenReason ?? '')}` : '',
              },
              {
                key: 'a',
                header: '',
                cell: (p) =>
                  p.status === 'open' && p.ended && can('finance.ledger_write') ? (
                    <Button size="sm" onClick={() => setClosing(p)}>
                      Close through it
                    </Button>
                  ) : p.status === 'closed' && can('finance.ledger_reopen') ? (
                    <Button size="sm" variant="danger" onClick={() => setReopening(p)}>
                      Reopen
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </QueryState>
      <ConfirmDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={`Close through ${closing?.month ?? ''}?`}
        description="It and every open month before it. No entry is then dated in them."
        confirmLabel="Close"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={() => closing && close.mutate(closing.month)}
      />
      <ReasonCodeDialog
        open={reopening !== null}
        onClose={() => setReopening(null)}
        title={`Reopen ${reopening?.month ?? ''}`}
        description="Entries may then be dated in it again. Recorded with the reason."
        codes={REASON_CODES.glPeriodReopen}
        confirmLabel="Reopen"
        danger
        pending={reopen.isPending}
        error={<ErrorAlert error={reopen.error} />}
        onConfirm={(reasonCode) => reopening && reopen.mutate({ month: reopening.month, reasonCode })}
      />
    </>
  );
}
