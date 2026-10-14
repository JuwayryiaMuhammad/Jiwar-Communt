# 0044 — Facilities and bookings: bookable and walk-in facilities, slots with a capacity that holds, quotas over any 7 days, approvals, closures, no-shows and suspensions, and the club's memberships paid at the office

**Status:** Accepted · Phase R5

## Context

Residents could not book the compound's courts, hall or barbecue area, nor see when the pool or the gym is open, and the management had no club membership a facility could require. This ADR adds all of it, and the manager dashboard's screens for it.

Out of scope: online payment (R6), QR check-in at a facility, a waitlist, dynamic pricing, staff booking on a resident's behalf.

The model follows R2 (ADR 0039), R3 (ADR 0040) and R4 (ADR 0042) wherever they meet: rules checked under a lock by the database's clock, append-only history where it matters, codes instead of free text outside what the staff write for residents, every response `no-store`, every table under RLS, forced, with composite foreign keys.

## Decisions

### A seventh domain: `src/facilities`

It imports core and community, through community's `index.ts`, and nothing else; nothing imports it. What it reads of community is `CommunityFacilitiesPort`: what an account may do on a unit (`capabilitiesFor`), whether it is the unit's primary, whether the household is under a separation, who may book for a unit, the unit's people for a club membership, and the codes and names the staff views show.

### Facilities

- **Two modes, never changed** (trigger): `bookable` (slots, a capacity, bookings) and `walk_in` (the pool, the gym: names, a description, weekly hours). A facility is never deleted; it is retired with `active`, which stops new bookings and hides it from residents. Bookings already made stay.
- **A bookable facility's rules**, set exactly when it is bookable (CHECK): slot length (15–480 min), capacity (1–500), counted in `bookings` or in `people`, days ahead (14), minutes of notice (60), cancellation cutoff (120 min), guests per booking (0), `requires_approval`, `requires_membership`, a weekly quota (2) and a peak quota (1, at most the weekly one).
- **Weekly opening hours and peak times**, in the compound's time zone, replaced as a whole under the facility's row lock. A peak time lies inside the hours; hours that would leave one outside are refused. A slot that overlaps a peak time is a peak slot. The weekly-window rules and a day's slots move from management to `src/core/common/slots/weekly-windows.ts`; management re-exports them.
- **Residents never see a capacity**: a slot is `free`, `full` or `closed`, and whether their unit holds it. Never how full, never by whom.

### Who books

- **An active resident or family account whose capabilities on the unit carry `bookings`** (ADR 0020: someone who lives there, or a member the primary gave the `bookings` grant), holding the role permission `facilities.book` (residents and family by default). A landlord does not book.
- **The booking is the unit's**, for its quotas, and records who made it. It is seen by its booker and by the unit's primary — except, during a separation, what others of the household made (ADR 0021). Either may cancel it.
- A booking names the start of one of the facility's slots exactly, not sooner than its notice and not further than its last local day; guests are a number, never names.
- It is confirmed at once, or `pending` when the facility requires approval. **An auto-confirmed booking notifies nobody**: the one who acted has the answer.

### Capacity, quotas and the lock order

- **Capacity cannot be exceeded.** A booking takes its slot's lock row (`facility_slot_locks`, a lock and nothing more) and counts what holds the slot (pending and confirmed: a pending booking holds its place), by bookings or by people, by overlap, so a booking made before the slot length changed still counts.
- **Quota: any 7 consecutive days** hold at most `weekly_quota` of the unit's pending, confirmed and no-show bookings at the facility, past ones included; cancelled and rejected ones do not count. A peak booking also respects `peak_quota` among peak bookings. Checked as the busiest 7-day window that would contain the new start (a pure function), under the unit's advisory lock.
- **One order, everywhere**: the caller's account (FOR SHARE), the unit's advisory lock, the facility's row (FOR SHARE; a change of its rules, hours, peaks or closures takes it FOR UPDATE), a club membership's row, the slot's lock row, the bookings' rows (by id).
- **No booking path takes a unit's row.** This phase found a deadlock that R2 already had: a write holding its author's account row inserted a row naming the unit, whose foreign-key check (`FOR KEY SHARE`) waited on `lockUnits`' `FOR UPDATE`, while the holder of the unit lock (removing a member, ending an occupancy) reached for that account. **`lockUnits` now takes `FOR NO KEY UPDATE`**: holders still exclude each other, and foreign-key checks no longer wait. This amends ADR 0016.

### Approvals

- The staff (`bookings.handle`) see every booking with its unit's code and its booker by name (or erased), a facility's day with how much of each slot is taken, and the queue of pending bookings.
- **An approval never confirms past the capacity as it is now.** It takes the facility's row FOR UPDATE — approvals of a facility go one at a time and no booking of it is being decided meanwhile — and counts the slot's confirmed bookings. After a capacity cut, the first approvals fill it and the rest are refused (409 `BOOKING_SLOT_FULL`).
- Approve and reject before the start (409 `BOOKING_WINDOW_PASSED`); reject with a reason code. The staff cancel a pending or confirmed booking before it ends, with a reason code, whatever the cutoff; a resident cancels a confirmed one until the facility's cutoff.
- **A pending booking nobody approved before its start** is cancelled by a sweep (every minute, `approval_expired`), one booking per transaction, judged again under the same locks: an approval that won stays.

### Closures

- A facility closes for a time (at most a year and a day) with a reason code (`facilities.manage`). Creating one takes the facility's row FOR UPDATE and **cancels every booking that holds a place in it and has not started** — by the system, `facility_closed`, pointing at the closure — and tells each booker. A booking under way is left as it is. A booking in flight either committed first and is cancelled, or waited on the facility and is then refused (409 `FACILITY_CLOSED`).
- A closure is lifted once, with a reason code (trigger); what it cancelled stays cancelled.
- R3's works announcements also have a free-text facility area; the two are not linked.

### No-shows and suspensions

- The staff mark a confirmed booking a no-show after its slot ended and within 72 hours. Final. A no-show keeps its place in the quota.
- **A unit's no-shows marked within the compound's window and since its last suspension began**, reaching the threshold (3 in 30 days), start a suspension of the compound's days (14), unless one is in force — decided under the unit's advisory lock, which a booking holds too, so a booking is decided before it or refused after it (403 `BOOKINGS_SUSPENDED`, `params.until`).
- **A suspension blocks new bookings only**: what the unit holds stays. Everyone who books for the unit is told; its people see it with its end (`GET /units/{unitId}/booking-standing`). The staff lift one in force with a reason code, once (trigger).
- The three numbers are the compound's settings (`facility_settings`, provisioned and backfilled).

### The club

- **Plans** (`facilities.manage`): names, a duration that never changes (monthly, quarterly, annual, or so many days) and a price shown in EGP.
- **One membership per unit**, and whom it covers: the unit's residing occupancies and household members, minors too, each covered only while still the unit's. The accountant sees the unit's people by full name, through the club's routes only, and nothing else of them.
- **A payment made at the office** (`club.billing`, the new staff role `accountant`) names an active plan, the amount paid in EGP, a receipt number (once per compound) and the local day it was paid (not ahead, at most 90 days ago). It pays for a period of the plan from that day, or from where the last period paid for ends (so one recorded late never lands before what was paid already): months on the same day of the month, or its last day.
- **Payments are append-only.** A wrong one is reversed by a new record with a reason code, once; the period it paid for no longer counts, and the gap it may leave stays. Every write to a membership takes its row FOR UPDATE, so two payments at once chain and never overlap.
- **A facility that requires membership** needs the unit's membership active on the slot's local day and covering the booker (403 `CLUB_MEMBERSHIP_REQUIRED`), checked holding the membership's row FOR SHARE. If it lapses or a payment is reversed, bookings already made stay.
- The unit's people see the membership with first names, and its payments only if they see the unit's money (`financeView`). A week before it ends, the people it covers with an account are told, once per end date.

### Permissions and roles

`facilities.book` (residents and family), `facilities.manage`, `bookings.handle` and `club.billing` (staff or manager; the manager role gets all three). The new staff role `accountant` holds `club.billing` alone. `pnpm access:sync` brings existing compounds the grants and the role.

### Notifications

A new category, `bookings`; no kind is critical; to the booker (or the unit's bookers, or a membership's people) and never the one who acted. Params are a reason's code at most (`reason`), never a facility's name, a time, a unit or a name: `booking.approved`, `.rejected`, `.approval_expired`, `.cancelled_by_staff`, `.cancelled_by_closure`, `.reminder` (once, two hours before a confirmed booking made at least two hours ahead; `reminded_at` claimed with a conditional update), `booking_suspension.started`, `club_membership.expiring`. Each has its English and Arabic push text, generic.

### Privacy and audit

- Audit rows carry ids, codes, counts, statuses, rules and windows by value; a facility's and a plan's names as `{ changed: true }` only; never a booker's name. A payment's row carries its amount, receipt number and period.
- **Deactivation and erasure** (an erasure deactivates the account first, inside it): the person's bookings that have not started are cancelled by the system (`booker_left`) and free their places; every booking stays and, once erased, points at the tombstone, shown to the staff as erased. **Leaving a unit**: on each unit they may no longer book for, what they booked there and has not started is cancelled, `booker_left`. Nobody is told. These hooks take no unit or facility lock: a cancellation only frees places and quota. A member who only loses the `bookings` grant keeps what they booked. Club coverage lapses by itself; payment records stay.
- **Export** (`facilities`): the account's own bookings, and per unit whose household it sees, the membership's state, its last day, since when it covers the account, and its payments only where it sees the unit's money. Nobody else's name.

## Consequences

- A seventh domain, with `facilities` in the lint boundaries; it may import community only.
- Thirteen tables in six migrations (`20261022090000` to `20261022090500`); the third adds the `bookings` category alone, as a new enum value must be.
- **This amends ADR 0016**: `lockUnits` takes `FOR NO KEY UPDATE`.
- **This amends ADR 0036**: a ninth delivery category, `bookings`, and a `facilities` export section.
- **This amends ADR 0039** only by moving the weekly-window rules to core; office hours behave as before.
- The manager dashboard gains Facilities, Bookings (the day view), Approvals, Suspensions, and the club's Memberships and Plans; an account holding only one of the new staff permissions may sign in.

## Open

- Staff cannot book on a resident's behalf, and there is no waitlist.
- A booking cancelled by an erasure or a departure tells nobody, not even the unit's primary.
- The memberships list is bounded (one per unit), not paged.
- Changing a facility's slot length leaves bookings on the old grid; they still take their place, and the day view lists them apart.
- A frozen account's bookings stay until it is erased or deactivated.
