'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { personName, postName } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardSwap, type GuardSwapStatus } from '@/lib/queries';

const VIEWS = ['accepted', 'requested', 'approved', 'all'] as const;
type View = (typeof VIEWS)[number];

const slotText = (s: GuardSwap['requesterSlot'] | null) =>
  s ? `${postName(s.post)} · ${formatDateTime(s.startsAt)}` : 'Nothing: a cover';

/**
 * Shift swaps (ADR 0050): a guard asks a colleague to take a slot, the
 * colleague accepts, and they are decided here. Approval checks again
 * that nothing changed and nobody is left with overlapping slots.
 */
export default function SwapsPage() {
  const toast = useToast();
  const { ready, can, me } = usePermissions();
  const allowed = can('guard_roster.manage');
  const [view, setView] = useState<View>('accepted');
  const [rejecting, setRejecting] = useState<GuardSwap | null>(null);
  const status: GuardSwapStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.swaps(status), (c) => fetchers.swaps(status, c), { enabled: allowed });
  const approve = useAction(
    (s: GuardSwap) => unwrap(api.POST('/api/v1/staff/security/swaps/{id}/approve', { params: { path: { id: s.id } } })),
    { invalidate: [keys.swapsAll, keys.rosterAll], onDone: () => toast.show('Approved: the slots have their new guards.') },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/swaps/{id}/reject', {
          params: { path: { id: rejecting!.id } },
          body: { reasonCode: reasonCode as (typeof REASON_CODES.guardSwapReject)[number] },
        }),
      ),
    {
      invalidate: [keys.swapsAll],
      onDone: () => {
        toast.show('Rejected. Both guards are told.');
        setRejecting(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Shift swaps" />
        <ForbiddenState />
      </>
    );
  const mine = (s: GuardSwap) => s.requester.id === me?.id || s.colleague.id === me?.id;
  return (
    <>
      <PageHeader title="Shift swaps" description="Accepted by the colleague: yours to approve or reject. A slot that starts first expires the swap." />
      <div className="toolbar">
        <Segmented<View>
          label="Swaps shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'accepted', label: 'To decide' },
            { value: 'requested', label: 'Waiting for the colleague' },
            { value: 'approved', label: 'Approved' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardSwap>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={view === 'accepted' ? 'Nothing to decide' : 'No swap'}
            columns={[
              { key: 'from', header: 'Asked by', cell: (s) => personName(s.requester) },
              { key: 'slot', header: 'Their slot', cell: (s) => slotText(s.requesterSlot) },
              { key: 'to', header: 'Colleague', cell: (s) => personName(s.colleague) },
              { key: 'back', header: 'In exchange', cell: (s) => slotText(s.colleagueSlot) },
              { key: 'reason', header: 'Reason', cell: (s) => s.reason ?? '—' },
              {
                key: 'status',
                header: 'Status',
                cell: (s) => (
                  <span className="row">
                    <StatusBadge status={s.status} />
                    {s.rejectReason || s.closeReason ? <span className="t-secondary">{humanize(s.rejectReason ?? s.closeReason ?? '')}</span> : null}
                  </span>
                ),
              },
              { key: 'when', header: 'Asked', cell: (s) => <span title={formatDateTime(s.createdAt)}>{relativeTime(s.createdAt)}</span> },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.status === 'accepted' && !mine(s) ? (
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <Button size="sm" variant="primary" loading={approve.isPending && approve.variables?.id === s.id} onClick={() => approve.mutate(s)}>
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(s)}>
                        Reject
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject this swap?"
        description="The slots stay with their guards."
        codes={REASON_CODES.guardSwapReject}
        confirmLabel="Reject"
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reasonCode) => reject.mutate(reasonCode)}
      />
    </>
  );
}
