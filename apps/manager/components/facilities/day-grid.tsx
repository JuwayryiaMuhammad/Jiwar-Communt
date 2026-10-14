'use client';

import { humanize } from '@jiwar/api';
import { Badge, Card, CardBody, CardHeader, StatusBadge } from '@jiwar/ui';
import { personName } from '@/components/management-requests/bits';
import type { FacilityDay, StaffBooking } from '@/lib/queries';
import { BookingActions } from './booking-actions';
import { dayGrid, takenText } from './logic';

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function BookingLine({ booking }: { booking: StaffBooking }) {
  const ended = booking.status === 'cancelled' || booking.status === 'rejected';
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center', opacity: ended ? 0.6 : 1 }}>
      <StatusBadge status={booking.status} />
      <span className="table__primary">{personName(booking.bookedBy)}</span>
      <span className="t-secondary">Unit {booking.unitCode}</span>
      {booking.guests ? <span className="t-secondary">+{booking.guests} guest{booking.guests === 1 ? '' : 's'}</span> : null}
      {booking.peak ? <Badge tone="terracotta">Peak</Badge> : null}
      {booking.cancelReason ? <span className="t-secondary">{humanize(booking.cancelReason)}</span> : null}
      {booking.rejectReason ? <span className="t-secondary">{humanize(booking.rejectReason)}</span> : null}
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
  const { rows, outside } = dayGrid(day.slots, day.bookings);
  return (
    <div className="stack">
      {rows.length === 0 ? <p className="t-secondary">No opening hours this day.</p> : null}
      {rows.map(({ slot, bookings }) => (
        <Card key={slot.startsAt} flush>
          <CardHeader
            title={`${time.format(new Date(slot.startsAt))}–${time.format(new Date(slot.endsAt))}`}
            actions={
              <span className="row" style={{ gap: 8 }}>
                {slot.peak ? <Badge tone="terracotta">Peak</Badge> : null}
                <Badge tone={slot.taken >= day.capacity ? 'error' : slot.taken ? 'green' : 'beige'}>
                  {takenText(slot.taken, day.capacity)} {day.capacityUnit === 'people' ? 'people' : 'booked'}
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
          <CardHeader title="Outside today’s slots" />
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
