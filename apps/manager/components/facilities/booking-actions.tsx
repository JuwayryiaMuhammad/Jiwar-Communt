'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, ReasonCodeDialog, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { usePersonName, useSlotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { keys, type StaffBooking } from '@/lib/queries';
import ar from '@/messages/ar/fac-bookings';
import en from '@/messages/en/fac-bookings';
import { bookingActions } from './logic';

type Open = 'reject' | 'cancel' | 'no_show' | null;

/**
 * What a handler may do to a booking now (ADR 0044), shown only when its
 * status and its time allow it. A booking that moved meanwhile answers
 * BOOKING_INVALID_TRANSITION, which is shown; every action refreshes the
 * day, the queue and the lists.
 */
export function BookingActions({ booking, compact }: { booking: StaffBooking; compact?: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const personName = usePersonName();
  const slotText = useSlotText();
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
    onDone: done(t('approved')),
  });
  const reject = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/bookings/{id}/reject', { ...path, body: { reasonCode } })),
    { ...SAVED, onDone: done(t('rejected')) },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/bookings/{id}/cancel', { ...path, body: { reasonCode } })),
    { ...SAVED, onDone: done(t('cancelled')) },
  );
  const noShow = useAction(() => unwrap(api.POST('/api/v1/staff/bookings/{id}/no-show', path)), {
    ...SAVED,
    onDone: done(t('noShowMarked')),
  });
  const actions = bookingActions(booking, new Date());
  if (!actions.length) return null;
  const who = t('who', { name: personName(booking.bookedBy), unit: booking.unitCode });
  const when = slotText(booking.startsAt, booking.endsAt);

  return (
    <>
      <span className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {actions.includes('approve') ? (
          <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
            {c('approve')}
          </Button>
        ) : null}
        {actions.includes('reject') ? (
          <Button size="sm" onClick={() => setOpen('reject')}>
            {c('reject')}
          </Button>
        ) : null}
        {actions.includes('cancel') ? (
          <Button size="sm" variant={compact ? 'text' : undefined} onClick={() => setOpen('cancel')}>
            {c('cancel')}
          </Button>
        ) : null}
        {actions.includes('no_show') ? (
          <Button size="sm" onClick={() => setOpen('no_show')}>
            {t('action.noShow')}
          </Button>
        ) : null}
      </span>
      {approve.error ? <ErrorAlert error={approve.error} /> : null}
      <ReasonCodeDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        title={t('rejectTitle')}
        description={t('rejectDescription', { who, when })}
        codes={REASON_CODES.bookingReject}
        confirmLabel={c('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={() => setOpen(null)}
        title={t('cancelTitle')}
        description={t('cancelDescription', { who, when })}
        codes={REASON_CODES.bookingStaffCancel}
        confirmLabel={t('cancelConfirm')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <Dialog
        open={open === 'no_show'}
        onClose={() => setOpen(null)}
        title={t('noShowTitle')}
        description={t('noShowDescription', { who, when })}
        onSubmit={() => noShow.mutate()}
        footer={
          <>
            <Button onClick={() => setOpen(null)}>{c('back')}</Button>
            <Button type="submit" variant="danger" loading={noShow.isPending}>
              {t('markNoShow')}
            </Button>
          </>
        }
      >
        <ErrorAlert error={noShow.error} />
      </Dialog>
    </>
  );
}
