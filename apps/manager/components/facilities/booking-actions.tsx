'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { personName, slotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { keys, type StaffBooking } from '@/lib/queries';
import { bookingActions } from './logic';

type Open = 'reject' | 'cancel' | 'no_show' | null;

/**
 * What a handler may do to a booking now (ADR 0044), shown only when its
 * status and its time allow it. A booking that moved meanwhile answers
 * BOOKING_INVALID_TRANSITION, which is shown; every action refreshes the
 * day, the queue and the lists.
 */
export function BookingActions({ booking, compact }: { booking: StaffBooking; compact?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const done = (message: string) => () => {
    toast.show(message);
    setOpen(null);
  };
  const SAVED = { invalidate: [keys.bookingsAll, keys.facilitiesAll, keys.suspensionsAll] };
  const path = { params: { path: { id: booking.id } } };
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/bookings/{id}/approve', path)), {
    ...SAVED,
    onDone: done('Approved. The booker is told.'),
  });
  const reject = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/bookings/{id}/reject', { ...path, body: { reasonCode } })),
    { ...SAVED, onDone: done('Rejected. The booker is told.') },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/bookings/{id}/cancel', { ...path, body: { reasonCode } })),
    { ...SAVED, onDone: done('Cancelled. The booker is told.') },
  );
  const noShow = useAction(() => unwrap(api.POST('/api/v1/staff/bookings/{id}/no-show', path)), {
    ...SAVED,
    onDone: done('Marked a no-show.'),
  });
  const actions = bookingActions(booking, new Date());
  if (!actions.length) return null;
  const who = `${personName(booking.bookedBy)}, unit ${booking.unitCode}`;
  const when = slotText(booking.startsAt, booking.endsAt);

  return (
    <>
      <span className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {actions.includes('approve') ? (
          <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </Button>
        ) : null}
        {actions.includes('reject') ? (
          <Button size="sm" onClick={() => setOpen('reject')}>
            Reject
          </Button>
        ) : null}
        {actions.includes('cancel') ? (
          <Button size="sm" variant={compact ? 'text' : undefined} onClick={() => setOpen('cancel')}>
            Cancel
          </Button>
        ) : null}
        {actions.includes('no_show') ? (
          <Button size="sm" onClick={() => setOpen('no_show')}>
            No-show
          </Button>
        ) : null}
      </span>
      {approve.error ? <ErrorAlert error={approve.error} /> : null}
      <ReasonCodeDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        title="Reject the booking?"
        description={`${who} · ${when}. Its place is freed; the booker is told why, as a code.`}
        codes={REASON_CODES.bookingReject}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={() => setOpen(null)}
        title="Cancel the booking?"
        description={`${who} · ${when}. The staff cancel whatever the facility’s cutoff; the booker is told why, as a code.`}
        codes={REASON_CODES.bookingStaffCancel}
        confirmLabel="Cancel booking"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <Dialog
        open={open === 'no_show'}
        onClose={() => setOpen(null)}
        title="Mark a no-show?"
        description={`${who} · ${when}. Final. Enough no-shows suspend the unit from booking for a while.`}
        onSubmit={() => noShow.mutate()}
        footer={
          <>
            <Button onClick={() => setOpen(null)}>Back</Button>
            <Button type="submit" variant="danger" loading={noShow.isPending}>
              Mark no-show
            </Button>
          </>
        }
      >
        <ErrorAlert error={noShow.error} />
      </Dialog>
    </>
  );
}
