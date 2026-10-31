# Booking extras and charges — notes for the apps (ADR 0070)

## Charges
- A booking's fee, a club request's price and a fine are **invoices of the unit's** (`kind: facility | club | fine`): listed, paid online and at the office, and receipted as any invoice. They are never split into instalments or disputed (`409 INVOICE_NOT_CONVERTIBLE` / `INVOICE_NOT_DISPUTABLE`, `reason: charge`).
- `BookingView.charge`, `ClubRequestView.charge` and a fine's `charge` give `{invoiceId, status: open | paid | cancelled}`; a fine also says `payable: online | office`.
- A facility's view has `fees {feeAmount, peakFeeAmount, refundCutoffHours}` (null for a walk-in one): show the price before booking, and that a cancel after the cutoff keeps the fee owed.

## Companions
- The booker: `POST /bookings/{id}/companions {memberId}`, `GET /bookings/{id}/companions`, `DELETE /bookings/{id}/companions/{companionId}?reasonCode=`, `POST /bookings/{id}/share-link` (the token once; build the link from it).
- Anyone of the compound with the link: `POST /booking-invites/preview {token}` (facility and time only), `POST /booking-invites/accept {token}`.
- The companion: `GET /me/companion-bookings`, `POST /me/companion-bookings/{companionId}/accept|decline`, `POST /bookings/{id}/companions/me/leave`.
- `BookingView.companions` is the seats they hold beside `guests`. When the booking ends (cancelled, rejected, expired, a no-show) every live place becomes `cancelled`.

## The waitlist
- `POST /facilities/{id}/waitlist {unitId, startsAt, guests?}` on a full slot; `GET /me/waitlist`; `POST /booking-waitlist/{id}/leave`; `POST /booking-waitlist/{id}/claim` (returns the booking).
- On `booking_waitlist.offered`, read the entry: `offerExpiresAt` is when the hold ends. A slot held by an offer is `full` for everyone else.

## Guest rooms
- A facility with `mode: stay` has `stay {rooms, checkInTime, checkOutTime, maxNights, …}` and no slots. Book with `POST /units/{unitId}/stays {facilityId, fromOn, toOn, guests?}`; the booking has `stayFromOn` and `stayToOn`.

## Rebook after a closure
- A booking with `rebookUntil` may be booked again once at its facility before then: `POST /units/{unitId}/bookings` with `rebookOf` (quotas skipped). Offer it from the `booking.cancelled_by_closure` notice.

## Club requests
- `POST /units/{unitId}/club-membership/requests {planId}`, `GET /units/{unitId}/club-membership/requests`, `POST /club-membership-requests/{id}/cancel {reasonCode}`. Pay the request's invoice as any; on `club_membership_request.paid`, refresh the membership.
