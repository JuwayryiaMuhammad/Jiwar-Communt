# 0045 — Vehicles and parking: a unit's vehicles with stickers and permits, the guard's plate lookup, slots and visitor parking with a capacity that holds, fines with one appeal and payments at the office, and parking reports whose reporter the reported unit never learns

**Status:** Accepted · Phase G2 · Gate card (vehicles, part B)

## Context

The mobile team builds the Gate card's second part on top of ADR 0043:
- a unit's vehicles and their permits;
- its parking slots;
- parking for its visitors;
- the fines it gets;
- the reports residents make about wrongly parked cars.

The guard needed to look a plate up. The management needed screens to approve vehicles, set up parking, fine, and work the reports.

Out of scope: service and delivery vehicles, plate-reading cameras, online payment of fines (R6), appeals to the board (R7).

The model follows ADR 0044 wherever they meet:
- rules are checked under a lock, by the database's clock;
- history is append-only where it matters;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### In the gate domain, like parcels

Vehicles, parking, fines and reports live in `src/gate` (`vehicles/`, `parking/`, `fines/`, `parking-reports/`), as parcels do (ADR 0035), not in a new domain.
- The guard's lookup reads visitor passes, and the gate's verify shows a pass's parking. Two domains would import each other.
- They read community through the existing `CommunityGatePort`, which gains `primaryOf`.

### One plate format, one key

- **The format:** ADR 0043's normaliser moves to `src/core/common/vehicle-plate.ts`, unchanged. Every plate the compound holds takes it: a visitor's, a vehicle's, a fine's, a report's. A plate is stored and shown as typed, tidied.
- **`plateKey`:** what two plates are compared by. It is the plate without its spaces, with its Arabic-Indic digits as Western ones, so `ق ب ط ١٢٣٤` and `قبط1234` are one plate.
  - The database computes the same key in a generated, indexed `plate_key` column on `visitor_details`, `vehicles`, `vehicle_fines` and `parking_reports`. A test feeds both the same plates.
  - Letters are not folded: plates use a closed set.

### Who keeps a unit's vehicles

- **A new capability, `vehicles`** (ADR 0020): a residing occupant, or an active adult member with an account. No grant is needed: they are the same people as `parcels`, through every review. Never a landlord, a minor, a pending or removed member, or an ended occupancy.
- **The role permission is `vehicles.register`** (residents and family).
- **Who does what:**
  - every keeper sees the unit's vehicles and registers one;
  - its registrant or the unit's primary edits or removes it (403 `VEHICLE_ACTION_NOT_ALLOWED`).
- **The licence photo** (file purpose `vehicle_licence`, an image or a PDF) is seen by the unit's keepers and the staff, never by the guard.
- **The limit:** at most `maxVehiclesPerUnit` (4) pending or active vehicles per unit, counted under the unit's vehicles advisory lock (409 `VEHICLE_LIMIT_REACHED`).

### Approval, stickers and permits

- **States:** a vehicle is `pending` until the staff (`vehicles.manage`) approve it or reject it with a reason code (`active` or `rejected`).
- **What approval sets:** a sticker number and the permit's last local day, after today and at most 731 days ahead.
- **Status at read time:** `expires_soon` (within 30 days) and `expired` (after the last day) are read when asked, never stored. The staff renew a permit, which keeps its sticker.
- **A decision names the `version` the staff read.** A plate edit bumps it, so a plate changed between reading and deciding is 409 `VEHICLE_CHANGED`, never approved unseen.
- **A sticker number is issued once in a compound, ever.**
  - `vehicle_stickers` is append-only, with a unique number, and a vehicle's own sticker must be one issued to it (composite foreign key).
  - A sticker voided by a plate edit or a removal is never valid again, on any car. The service and the unique index answer alike: 409 `DUPLICATE_RESOURCE` on `stickerNumber`.
- **One active permit per plate in a compound**, decided under the plate's advisory lock, with a partial unique index behind it (409 `VEHICLE_PLATE_ACTIVE`).
  - A pending duplicate is allowed: refusing it at registration would tell a resident that a plate is registered somewhere.
- **Editing:**
  - a new plate (not the same plate typed differently) sends the vehicle back to `pending`: its sticker void, its permit gone, its version up;
  - colour, model, type and the photo keep its status;
  - a rejected vehicle given a new plate waits again, within the limit.
- **Removal** (by the unit, the staff with a reason code, or the system) is final (trigger). The licence photo is deleted 30 days later.

### The registrant goes

When the registrant no longer holds `vehicles` on a unit (they left, their occupancy ended, they were removed from the household, deactivated, or erased; an erasure deactivates first):
- the vehicles they registered there that are pending or active are removed by the system (`registrant_left`), and their permits are void;
- the unit's primary is told (`vehicle.registrant_left`), so a car that stays is registered again, unless the one who left is the primary or the unit has none;
- the rows stay, pointing at the tombstone once erased.

### The guard's plate lookup

- **The route:** `POST /gate/plate-lookup` (`gate.operate`, inside an open shift, the guard's own rate limit). The plate goes in a body, never a URL.
- **What it returns,** by key:
  - the units' pending and active vehicles, with the permit's status, last day and sticker;
  - the active visitor passes carrying the plate that are valid within a day, with whether the pass lets its visitor in now (or why not) and their parking booking.
- **Never a name:** neither the registrant's nor the visitor's.
- **Every lookup is audited** (`gate.plate_lookup`, on the guard's shift) with the ids it found and their count.
  - Never the plate, nor a hash of it: a plate is a few letters and digits, so an unkeyed hash is read back by trying them all, and a keyed one would add a secret for nothing the ids do not already say.
  - `plate` is now always sensitive in the audit trail.
- **On verify:** `POST /gate/verify` on a valid visitor pass shows its parking: the booking holding now, or the next within two hours.
- **The gate's list:** `GET /gate/visitor-parking` lists the bookings holding now or starting within two hours. It shows the visitor's name only for a booking without a pass, the one way the guard can tell that car.

### Slots and visitor parking

- **Slots and areas:**
  - a unit's own slots are configuration (a code once in the compound, a place), kept by `vehicles.manage`;
  - visitor areas have a name and a capacity; they are retired, never deleted.
- **The unit's view:** `GET /units/{unitId}/parking` shows the unit's slots and each active area's free spaces now.
- **Booking:** whoever may invite visitors books one space of an area for a window, for one of these:
  - a pass of the unit they manage (its host or the primary), active, the window inside its validity;
  - a visitor's name.
- **The window:** whole minutes, from 15 minutes to `visitorParkingMaxHours` (12), starting no earlier than 15 minutes ago and at most 14 days ahead.
- **The unit's limit:** at most `maxActiveVisitorParkingBookings` (3) not yet ended per unit, under the unit's parking advisory lock.
- **Capacity holds at every instant.**
  - A booking takes the area's row and counts, under it, the most bookings that hold one instant of its window (`peakOverlap`, windows half-open).
  - This is the exact form of counting by overlap: windows that never overlap both fit.
  - A smaller capacity or a retirement leaves what is booked.
- **Who sees what:** the primary sees every booking, anyone else their own. Only the booker sees the visitor's name, which is deleted 30 days after the booking ends.
- **Cancelling:**
  - the booker or the primary, until it ends;
  - the staff, with a reason code;
  - the system: a cancelled pass takes its bookings with it (`pass_cancelled`, in the pass's transaction, which holds the pass's row a booking takes FOR SHARE), and a booker who goes takes theirs (`booker_left`).
- **The lock order:** the caller's account, the unit's parking lock, the pass's row, the area's row, the counter. No path locks a unit's row (ADR 0044).

### Fines

- **Issuing** (`fines.issue`). A fine to a unit names:
  - one of its vehicles (its plate snapshotted) or a typed plate;
  - a reason code;
  - an amount in EGP (up to 100,000);
  - the local day it happened (within 90 days);
  - a note the unit reads, and a photo (`vehicle_fine_photo`).

  Its terms never change (trigger). The unit's keepers and its primary are told, with the reason's code only.
- **Who sees it:** the unit's keepers and whoever sees its money (`vehicles` or `financeView`).
  - The resident filter is `unpaid` (with what is under appeal), `paid` or `cancelled`.
  - **A fine carries nothing of where it came from.**
- **The appeal:** a keeper or the primary appeals once, within 30 days, with words and an optional photo (`parking_photo`).
  - The appeal's fields are written once (trigger).
  - The staff uphold it (unpaid again) or cancel the fine with a reason code (`appeal_accepted` by default). The appellant is told either way.
  - An erased appellant's words and photo are cleared, and that clearing is the only update an appeal takes. The appeal's date, its decision and its reason stay.
- **Cancelling:** an unpaid fine not under appeal is cancelled with a reason code. A cancellation is final.
- **Paid at the office** (`fines.billing`, the accountant), as the club's memberships are (ADR 0044):
  - the whole amount, a receipt number (once among the compound's fine payments) and the local day it was paid (not ahead, at most 90 days ago, not before the fine's day);
  - payments are append-only: a wrong one is reversed by a new record, once, and the fine is unpaid again;
  - every write takes the fine's row, so a fine is `paid` exactly while a payment without a reversal holds it;
  - a fine under appeal waits for the decision (409 `FINE_UNDER_APPEAL`).

### Parking reports

- **Filing:** `POST /parking-reports` (`parking.report`, anyone who lives in or belongs to a unit) takes a plate, where, a note and a photo.
  - It is about a plate, never a unit: the answer is the same whether the plate matches anything or not.
  - At most 10 open per resident.
  - The reporter's list says open or closed, never the outcome.
- **Handling:** security (`parking_reports.handle`) sees the reporter, the photo and the plate's matches. It closes a report with a reason code, or turns it into a fine (with `fines.issue`), once.
- **The reported unit never learns who reported.**
  - The fine is issued as any fine is: nothing of the report goes on it, not the reporter, not the report's photo, not a link.
  - The report points at the fine; the fine never at the report.
  - A converted fine is key for key a direct one, in the unit's views, its notification and its audit rows.
- **Erasure:** the reporter's erasure clears their note and photo.

### Permissions and roles

| Permission | Who holds it |
|---|---|
| `vehicles.register` | residents and family |
| `parking.report` | residents and family |
| `vehicles.manage` | staff or manager; the manager role |
| `fines.issue` | staff or manager; the manager role |
| `fines.billing` | staff or manager; the manager role and the accountant |
| `parking_reports.handle` | staff or manager; the manager role |

- The accountant now also holds `fines.billing`.
- The guard's lookup is `gate.operate`. No default staff role works vehicles, fines or reports: a compound gives them to a role of its own.
- `pnpm access:sync` brings existing compounds the grants.

### Notifications

- A new category, `vehicles`. No kind is critical.
- Recipients never include the one who acted. Params are a reason's code at most: never a plate, a unit, an amount or a name.

| Kind | Who is told |
|---|---|
| `vehicle.approved` | the registrant |
| `vehicle.rejected` | the registrant |
| `vehicle.permit_expiring` | the registrant (or else the primary), once per last day, 30 days ahead |
| `vehicle.registrant_left` | the primary |
| `vehicle_fine.issued` | the keepers and the primary |
| `vehicle_fine.appeal_upheld` | the appellant |
| `vehicle_fine.appeal_accepted` | the appellant |

Each has its English and Arabic push text, generic.

### Privacy and audit

- **Audit rows** carry ids, codes, statuses, days, amounts and numbers.
  - A plate only as changed; an area's name only as changed.
  - Never a visitor's name, a note, a report's place or an appeal's words.
- **Erasure:** what the person wrote goes, and the unit's records stay:
  - a report's note and photo;
  - an appeal's words and photo;
  - the visitors' names on their bookings;
  - their vehicles' licence photos.
- **Export** (`vehicles/`):
  - the vehicles the account registered and those of the units where it keeps vehicles, with whether each has a licence photo;
  - its visitor bookings;
  - the fines it sees, with payments only where it sees the unit's money;
  - its own reports.
  - The licence photo itself is the vehicle's file, not the account's, and an export carries the account's own files only (ADR 0036).

## Consequences

- **Migrations:** seven, `20261023090000` to `20261023090600`. The first adds the visitor plate key. The second holds the new enum values alone, as it must.
- **Tables:** eleven new tenant tables, each under RLS, forced, with composite keys. Every new CHECK is reviewed in the CHECK map.
- **Append-only:** stickers, expiry reminders and fine payments are append-only even for their owner. Vehicles, visitor bookings, fines and reports are guarded by triggers.
- **This amends ADR 0036:** a tenth delivery category, `vehicles`, and a `vehicles` export section.
- **This amends ADR 0043:** the visitor plate gains its key, and the visitor parking it left open comes here.
- **This amends ADR 0044:** the accountant also records the fines' payments.
- **The manager dashboard gains:**
  - Vehicles (the approvals queue);
  - Visitor parking;
  - Parking setup;
  - Fines (appeals and the accountant's payments);
  - Parking reports.

  An account holding only one of the new staff permissions may sign in.

## Open

- A lost sticker is not replaced as such. A plate edit voids it, or the vehicle is removed and registered again.
- A fine is paid in full only, at the office; online payment is R6.
- Arabic letter variants (`ي`/`ى`, `أ`/`ا`) are not folded in plate matching.
- A booking cancelled by the staff tells nobody; the household sees it cancelled.
- A frozen account's vehicles stay until it is deactivated or erased (freezing takes no capability away).
