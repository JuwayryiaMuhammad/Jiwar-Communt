'use client';

import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, CardBody, CardHeader, StatusBadge, useLabel } from '@jiwar/ui';
import { usePersonName } from '@/components/management-requests/bits';
import type { FacilityDay, StaffBooking } from '@/lib/queries';
import ar from '@/messages/ar/fac-bookings';
import en from '@/messages/en/fac-bookings';
import { BookingActions } from './booking-actions';
import { dayGrid, takenText } from './logic';

function BookingLine({ booking }: { booking: StaffBooking }) {
  const t = useT(en, ar);
  const label = useLabel();
  const personName = usePersonName();
  const ended = booking.status === 'cancelled' || booking.status === 'rejected';
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center', opacity: ended ? 0.6 : 1 }}>
      <StatusBadge status={booking.status} />
      <span className="table__primary">{personName(booking.bookedBy)}</span>
      <span className="t-secondary">{t('unitCode', { code: booking.unitCode })}</span>
      {booking.guests ? <span className="t-secondary">{t('guests', { n: booking.guests })}</span> : null}
      {booking.peak ? <Badge tone="terracotta">{t('peak')}</Badge> : null}
      {booking.cancelReason ? <span className="t-secondary">{label(booking.cancelReason)}</span> : null}
      {booking.rejectReason ? <span className="t-secondary">{label(booking.rejectReason)}</span> : null}
      <span className="spacer" />
      <BookingActions booking={booking} compact />
    </div>
  );
}

/**
 * A facility's day for the staff (ADR 0044): each slot of its hours, how
 * full it is, and the bookings in it by booker and unit; bookings that fit
 * no slot of today's hours (made before they changed) are listed apart.
 */
export function DayGrid({ day }: { day: FacilityDay }) {
  const t = useT(en, ar);
  const f = useFormat();
  const { rows, outside } = dayGrid(day.slots, day.bookings);
  return (
    <div className="stack">
      {rows.length === 0 ? <p className="t-secondary">{t('noHours')}</p> : null}
      {rows.map(({ slot, bookings }) => (
        <Card key={slot.startsAt} flush>
          <CardHeader
            title={
              <span className="ltr">
                {f.time(slot.startsAt)}–{f.time(slot.endsAt)}
              </span>
            }
            actions={
              <span className="row" style={{ gap: 8 }}>
                {slot.peak ? <Badge tone="terracotta">{t('peak')}</Badge> : null}
                <Badge tone={slot.taken >= day.capacity ? 'error' : slot.taken ? 'green' : 'beige'}>
                  <span className="ltr">{takenText(slot.taken, day.capacity)}</span>{' '}
                  {day.capacityUnit === 'people' ? t('taken.people') : t('taken.bookings')}
                </Badge>
              </span>
            }
          />
          {bookings.length ? (
            <CardBody>
              <div className="stack stack--sm">
                {bookings.map((b) => (
                  <BookingLine key={b.id} booking={b} />
                ))}
              </div>
            </CardBody>
          ) : null}
        </Card>
      ))}
      {outside.length ? (
        <Card flush>
          <CardHeader title={t('outside')} />
          <CardBody>
            <div className="stack stack--sm">
              {outside.map((b) => (
                <BookingLine key={b.id} booking={b} />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
