'use client';

import { humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BookingSuspension } from '@/lib/queries';

const day = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Units suspended from booking after no-shows (ADR 0044). While a
 * suspension is in force the unit makes no new booking; what it holds
 * stays. A handler may lift one, with a reason code.
 */
export default function BookingSuspensionsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('bookings.handle');
  const [inForce, setInForce] = useState<'true' | 'false'>('true');
  const [lifting, setLifting] = useState<BookingSuspension | null>(null);
  const list = useCursorList(keys.suspensions(inForce), (c) => fetchers.suspensions(inForce, c), { enabled: allowed });
  const lift = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/booking-suspensions/{id}/lift', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.suspensionsAll],
      onDone: () => {
        toast.show('Lifted. The unit may book again.');
        setLifting(null);
      },
    },
  );
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title="Suspensions" description="Units suspended from booking after too many no-shows. The rules are under Facilities → No-show rules." />
      <div className="toolbar">
        <Segmented<'true' | 'false'>
          label="Suspensions shown"
          value={inForce}
          onChange={setInForce}
          options={[
            { value: 'true', label: 'In force' },
            { value: 'false', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BookingSuspension>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={inForce === 'true' ? 'No unit is suspended' : 'No suspension yet'}
            columns={[
              { key: 'unit', header: 'Unit', cell: (s) => <span className="t-mono">{s.unitCode}</span> },
              { key: 'since', header: 'Since', cell: (s) => day.format(new Date(s.startsAt)) },
              { key: 'until', header: 'Until', cell: (s) => day.format(new Date(s.endsAt)) },
              { key: 'count', header: 'No-shows', cell: (s) => s.noShowCount },
              {
                key: 'state',
                header: 'State',
                cell: (s) =>
                  s.liftedAt ? (
                    <Badge tone="beige">Lifted · {humanize(s.liftReasonCode)}</Badge>
                  ) : new Date(s.endsAt) <= new Date() ? (
                    <Badge tone="beige">Over</Badge>
                  ) : (
                    <Badge tone="error">In force</Badge>
                  ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (s) =>
                  !s.liftedAt && new Date(s.endsAt) > new Date() ? (
                    <Button size="sm" onClick={() => setLifting(s)}>
                      Lift
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={lifting !== null}
        onClose={() => setLifting(null)}
        title={`Lift the suspension of unit ${lifting?.unitCode ?? ''}?`}
        description="The unit may book again at once."
        codes={REASON_CODES.bookingSuspensionLift}
        confirmLabel="Lift"
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(reasonCode) => lifting && lift.mutate({ id: lifting.id, reasonCode })}
      />
    </>
  );
}
