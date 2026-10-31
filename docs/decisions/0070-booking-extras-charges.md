# 0070 — Booking extras and charges: companions, the waitlist, guest rooms by the night, a rebook after a closure, and bookings, club requests and fines owed through finance

**Status:** Accepted · R11c-1b · amends ADR 0044 (bookings: companions' seats, waitlist offers held as taken, a stay mode, a rebook, fees), 0045 (vehicle fines owed through an invoice), 0046 (charge invoice kinds, a system credit note), 0048 (no instalments or disputes on a charge's invoice), 0067 (a ban's and a closure's cancels free seats in order)

## Context

The resident's audit left the booking extras — companions, a waitlist, overnight guest rooms, a priority rebook after a closure — and three things a unit owes outside finance today: a booking's fee, a club plan's price ("shown, not enforced"), and a vehicle fine paid only at the office. R11c-1a (ADR 0069) took the rest of money and the unit; R11c-2 (ADR 0071) follows.

## Decisions

### Charges: a core port finance implements

- **The port** (`src/core/charges`): nothing imports finance (ADR 0015, 0046), so core holds a registry finance implements at startup — `lockUnit`, `raise`, `cancel`, `of`, `payAtOffice`, `reverseAtOffice` — and a source with work to do registers a **paid handler** (and, when its paid state can go back, an **unpaid handler**). Sources: `booking`, `club_request`, `vehicle_fine`.
- **A charge** is a one-line invoice of the unit's, of its source's kind — `facility`, `club`, `fine` (enum values alone in their migration) — issued through the staff's own issue (its number, the unit told, its credit poured in), and a `finance_charges` row: one per source row, one per invoice; its terms never change; cancelled once (trigger). Only the port issues these kinds: the staff's issue and the billing plans take `STAFF_INVOICE_KINDS` (a CHECK on the plans).
- **Paid** is stamped when payments settle its invoice — after every allocation (an office or online payment, a reversal, a credit note's release, an issue, an instalment plan, a refund reversed, a dispute decided) — in that transaction, which runs the source's handler. A reversed office payment that leaves it owed again clears the stamp (`finance_charge.reopened`) and runs the unpaid handler; the stamp never moves otherwise.
- **Cancel** credits what the invoice could still take, reason `charge_cancelled` (a system reason: by whoever cancelled the source, or nobody — `credit_notes.created_by` may be null for it alone): unpaid, it owes nothing more; paid, the money is the unit's credit and pays its other invoices (cash back through the manager's refund). Codes `chargeCancel`: `booking_cancelled`, `booking_rejected`, `closure`, `appeal_accepted`, `fine_cancelled`, `request_cancelled`.
- **A charge's invoice is never split or disputed** (`INVOICE_NOT_CONVERTIBLE` / `INVOICE_NOT_DISPUTABLE`, `reason: charge`): it is paid or cancelled whole, and disputed through what raised it — a fine's appeal, a booking's or a request's cancel.
- **The lock rule.** A payment takes the finance locks, then a handler's rows. So every path that touches a charge takes the unit's finance lock before its own rows a handler also locks: a facility's paths right after the facility's row (before the club's membership, the slot and the booking); a fine's paths before the fine's row; a ban, a closure and a booker leaving before their bookings' rows.

### Booking fees

- A facility may charge a fee per booking (`feeAmount`), another at peak times (`peakFeeAmount`), and a `refundCutoffHours` (0–168, default 24); none for a walk-in facility (CHECK `facilities_fees`). A stay's fee is per night.
- Raised when a booking is **confirmed** — at once, or at the staff's approval — due on its local day; a booking is never held for payment. Shown on the booking (`charge`) to the household and the staff.
- A resident who cancels before the cutoff is credited in full, later not; the staff, a ban, a closure and the system always credit it.

### Club membership requests

- `POST /units/:unitId/club-membership/requests {planId}` — whoever books for the unit, an active plan, one request open per unit (`CLUB_REQUEST_OPEN`, a partial unique key). Its price is owed at once through a `club` invoice due in a week.
- **Paid**, the handler starts the membership or extends it from where its last paid period ends (from today when lapsed): a payment record of the plan that points at the charge, with no receipt number of the club's and no recorder (`club_payment_records.charge_id`, its kind shape rewritten). A unit with no membership gets one covering its people now, started by the requester. The requester is told (`club_membership_request.paid`). Such a record is never reversed in the club (`CLUB_PAYMENT_FROM_CHARGE`): its money is finance's.
- **Called off** by the requester or the unit's primary until paid (`CLUB_REQUEST_CLOSED` after), with `clubRequestCancel`: the charge is credited off.
- The club's staff list requests (`club.billing`). "The price is enforced" reads as: the request charges the plan's price; the office's record keeps the amount it was paid.

### Vehicle fines

- A fine issued from now on raises a `fine` charge due in two weeks, payable online; its views say `payable: online` and carry the invoice. Older fines stay `office`.
- **Paid** through finance, an unpaid fine not before the board is paid (`vehicle_fine.paid`); one under the staff's or the board's appeal stays, and the decision reads its charge (upheld → paid if it was).
- **The office** still takes a fine on its route: its cash becomes finance's office payment of the invoice through the port, and the fine's payment record points at it (`vehicle_fine_payments.finance_payment_id`); reversing the record reverses it, and the invoice is owed again (`vehicle_fine.reopened` when a reversal in finance did it).
- An accepted appeal, the staff's cancel and the board's overturn credit the charge off.

### Companions

- The booker invites one of the household by member id (they accept or decline, `booking.companion_invited`), or shares the booking's **link**: a random token shown once, its SHA-256 kept on the booking, working until the start, replaced when rotated. Its preview shows the facility and the time, never the booker; joining by it is accepted at once.
- **A seat from the invite:** `bookings.companions` counts those invited or accepted (party_size never changes, so the seats are a counter beside it); a slot counted in people takes them; guests plus companions stay within `max_guests` (`BOOKING_PARTY_FULL`).
- Refused: the booker (`COMPANION_IS_BOOKER`), an account banned from the facility (`FACILITY_BANNED`, again at acceptance), a suspended unit, twice (`COMPANION_EXISTS`). A companion leaves; the booker removes one with `companionRemove` (`DELETE …/companions/:companionId?reasonCode=`: a DELETE takes no body, ADR 0025).
- **A booking that ends ends its companions' places**, `cancelled`, its seats back to 0 — however it ends: the resident's cancel, the staff's (and a facility ban's), a closure, a booker who left, a rejection, an approval that expired, a no-show. One helper (`BookingsService.endCompanions`) on every path, under the booking's row lock. They are told when it was called off (`booking.companion_cancelled`, no params), not after a no-show. A stay takes no companions.

### The waitlist

- A resident waits for a **full** slot (`BOOKING_SLOT_AVAILABLE` otherwise), at least fifteen minutes ahead, three slots at once per account, once per slot.
- **Offers in the order of joining.** Whatever frees room — a resident's, the staff's, a ban's or the system's cancel, a rejection, a companion declining, leaving or removed — offers it under the slot's row lock to the waiting entries, one by one while each fits (one that does not fit stops the line). An offer holds its place for the compound's `waitlistHoldMinutes` (a facility setting, 5–120, default 30), never past fifteen minutes before the start; closer, entries lapse. Told `booking_waitlist.offered`.
- **A live offer counts as taken** in `book()` and in the slots residents see; claimed (`POST /booking-waitlist/:id/claim`), `book()` decides it as any booking, quotas included, and frees only its own hold.
- The sweep `facilities.waitlist` (every minute) lapses an expired offer and offers the next; a closure closes the entries of the slots it covers (`booking_waitlist.closed`). Every path that frees a slot takes the slot's row before the booking's; entries change only under it. A stay takes no waitlist.

### Overnight guest rooms

- A facility of the mode `stay` (the enum value alone in its migration): rooms (its capacity, in bookings), check-in and check-out (local minutes; `HH:MM` in the API), `maxNights` 1–14; no slots, peaks, approval, companions or waitlist (the rules' shape CHECK, for three modes).
- `POST /units/:unitId/stays {facilityId, fromOn, toOn, guests}` — the first night and the check-out day (`@IsLocalDate`); its start and end are the check-in and check-out instants in the compound's zone. Refused when a night has no room (`STAY_NIGHT_FULL {nightOn}`), longer than `maxNights` (`STAY_TOO_LONG`), too soon or too far, closed over, or past the weekly quota, where a stay counts as one booking.
- **Night locks** (`facility_night_locks`) taken FOR UPDATE in ascending order before counting: overlapping stays never wait in a cycle.
- Cancelled, closed over (by its window), read and listed as any booking; its no-show is taken from its check-in.

### Priority rebook after a closure

- A booking a closure cancels keeps `rebook_until`, 72 hours after the cancel. `POST /units/:unitId/bookings` with `rebookOf` books the same facility again once, skipping the weekly and peak quotas that once; the new booking points at the one it replaces (a unique key). `REBOOK_NOT_ALLOWED {reason: other_facility | not_closed | expired | rebooked}`.

### Notifications

- New kinds, category `bookings`, none critical: `booking.companion_invited`, `booking.companion_cancelled`, `booking_waitlist.offered`, `booking_waitlist.closed`, `club_membership_request.paid`. Their params are empty: never a time or a facility's name (ADR 0044's rule); the app reads the entry or the booking. The closure's notice keeps its params; the booking carries `rebookUntil`.

### Personal-data export

- The account's own rows, through its own views (ADR 0036), in the `facilities` section: `club-requests.json` (the plans it asked for, each with its charge), `companions.json` (`places`: the bookings it joined, as it sees them — the booking's facility, time and state, never who booked; `invited`: the invites on its bookings — booking, how, state and days, never who), `waitlist.json` (every slot it waited for and how the wait ended). Stays and rebooks are bookings, in `bookings.json` already.

### Audit

- `finance_charge.raised|paid|cancelled|reopened`, `club_membership_request.created|cancelled|paid`, `vehicle_fine.paid|reopened`, `booking_companion.invited|joined|accepted|declined|left|removed`, `booking.share_link_rotated` (never the token), `booking_waitlist.joined|left|offered|claimed|lapsed`. Codes, ids, amounts and days; never a name.

## Deferred

- A reversed payment never undoes the club's membership period; the request stays paid.
- Stays are not in M1-3b's usage report.
- Unit violations (ADR 0053) are not owed through charges yet: the same port in a later fix.
