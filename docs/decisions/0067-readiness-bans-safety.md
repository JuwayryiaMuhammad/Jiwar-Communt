# 0067 — Readiness programs, facility bans and use, and the technician's safety: work permits, safety instructions, incidents and SOS from a ticket

**Status:** Accepted · M1-3b · amends ADR 0044 (bookings: a ban beside the suspension, a cancel reason), 0047 and 0053 (emergencies and incidents gain a ticket origin; the guard's SOS logic is shared), 0058 (the start rule beside the quote's), 0064 (inspections created in another write's transaction)

## Context

The roles' list gives the compound manager readiness for Ramadan, Eid, the summer, events and emergencies — checklists, resources and budget, contracts reviewed before the peak — and, for the facilities, a usage report and a manual ban. It gives the technician hazardous-work permits, safety instructions they sign, hazard and injury reports with a photo, and an SOS. M1-3a (ADR 0066) took energy and outages. R11c (the resident's own unit) follows.

## Decisions

### Permissions

- **`readiness.manage`:** the programs, their items, campaigns and contract reviews. The maintenance supervisor and the manager.
- **`safety.manage`:** decides work permits and keeps the safety instructions. The same two.
- Bans are worked with `bookings.handle`; the usage report reads with `facilities.manage` or `bookings.handle`. The hazards a category's work needs a permit for are set with `maintenance.manage`, an asset type's with `assets.manage`.
- An item's owner marks their own item done with no permission (`/staff/readiness-items`); another's is not found.

### Readiness programs

- **A program** is a `season`, an `event` or an `emergency` over days it states (`startsOn`, `endsOn`, `@IsLocalDate`): Ramadan and Eid move, so no calendar is assumed. At most a year and a day. Its title is the compound's words: audited as changed only.
- **Items:** a `task`, an `estimate`, a `contract_review` or an `inspection_campaign`. Each names what its kind needs and nothing else (a CHECK): a contract only for a review, a checklist only for a campaign, an amount always for an estimate and optionally for a task.
  - **The amount** is EGP, `DECIMAL(12,2)`, a string in the API (`^\d{1,10}(\.\d{1,2})?$`, more than 0), `Prisma.Decimal` in code: never a float.
  - **The owner** is an active staff member or the manager, told the day only (`readiness_item.assigned`); a new owner is told too.
  - **The day** is from today and by the program's last day (`READINESS_DUE_AFTER_END {endsOn}`); preparing comes before the season starts, so nothing ties it to the first day. A program ends on or after its items' days (`READINESS_ITEMS_DUE_LATER {dueOn}`).
  - **Done or called off once** (a trigger), never both; a call-off has a `readinessItemCancel` reason. A contract review is done with its decision (`renew | replace | end`). A campaign is done by its inspections, never by hand (`READINESS_CAMPAIGN_AUTOMATIC`).
- **Readiness** is done over what is not called off, in whole percent; the **budget** is the estimates of the items not called off. Both computed on read.
- **Closed once:** then neither the program nor its items change (`READINESS_PROGRAM_CLOSED`).
- **Overdue:** the sweep `maintenance.readiness` tells an owner once that an open item of an open program is past its day (`readiness_item.overdue`); a later day is a new chance.
- **Copy** to a new start (`POST …/programs/:id/copy {startsOn}`, from today): its kind and title; its end and every item's day move by as many days as the start. Its tasks, estimates and campaigns come open again; its contract reviews do not (the contracts that end in time are the new program's own to list), nor what was called off. An owner who may no longer own an item (not active, or no longer staff) is replaced by the copier, and listed in `reassignedItemIds`. A program is copied to a start once: the same idempotency key replays the copy, another is `409 DUPLICATE_RESOURCE` on `startsOn` (the unique `readiness_programs_copy_key`).
- **Locks:** the caller's account and an owner's (FOR SHARE), then the program (FOR UPDATE to change or copy it, FOR SHARE to change an item), then the item.

### Contract reviews

- `GET …/programs/:id/contracts-due` lists the maintenance contracts in force (not terminated) that end by the program's last day and not before today, soonest first, each with its review if it has one.
- A review names such a contract (`CONTRACT_NOT_DUE_FOR_REVIEW` otherwise), once per program unless that review was called off (a partial unique key: `409 DUPLICATE_RESOURCE` on `contractId`).
- Done with its decision code; the contract itself is not changed by it.

### Inspection campaigns

- `POST …/items/:itemId/campaign {inspectorId, assetIds?, commonAreaIds?}` schedules one inspection per target, due on the item's day, given to an inspector (an active `inspections.perform` holder), through `InspectionsService.createInTx` — split out of `create`, as M1-2 split `proposeLocked` — so each is an inspection like any other, told and audited as one (with `readinessItemId`).
- **Targets:** an asset of the compound's (never one in a unit) or an active common area; a bad one is named by its place (`assetIds.<i> ASSET_NOT_AVAILABLE`, `commonAreaIds.<i> COMMON_AREA_NOT_AVAILABLE`). At most 200 at once.
- **Each target once per campaign** (unique keys of `readiness_campaign_inspections`, written under the item's FOR UPDATE): spawning again, or twice at once, adds only the targets it does not hold.
- A campaign whose day has passed is moved before it spawns (`409 READINESS_ITEM_PAST_DUE`).
- **Done:** in the transaction that submits or cancels its last open inspection, by nobody — a hook `InspectionsService` runs under the inspection's lock, which then takes the program (shared) and the item. An inspection is never locked after an item, so the two never cycle. A campaign of a closed program stays as it is.
- It is not called off while an inspection of it is open (`409 READINESS_CAMPAIGN_OPEN {open}`): cancel the inspections, and it is done.

### Facility bans

A ban stands beside a unit's no-show suspension, not on it:

| | No-show suspension (ADR 0044) | Facility ban (ADR 0067) |
|---|---|---|
| Who | a unit | one account: a resident or a family member |
| Started by | the system, at the no-show threshold | the staff, with a `facilityBan` reason |
| Scope | every facility | one facility or all |
| Window | `starts_at`/`ends_at` instants, 90 days at most | from now until `ends_on` (a compound day, inclusive, within a year) or until lifted |
| Lock | the unit's advisory lock | the account FOR UPDATE |
| Board appeal | yes (ADR 0055) | no |
| Refusal | `403 BOOKINGS_SUSPENDED {until}` | `403 FACILITY_BANNED {facilityId?, until?}` |

- **`book()` order,** one code per cause: the booker's account (FOR SHARE) and the unit's lock, as before; the capability (`BOOKINGS_NOT_ALLOWED`); the unit's suspension (`BOOKINGS_SUSPENDED`); the facility (FOR SHARE); then **the booker's ban in force** at this facility or at all (`FACILITY_BANNED`). The ban takes the account FOR UPDATE, which a booking holds FOR SHARE: a booking either committed before the ban (and is cancelled by it) or waits and meets it.
- **Starting a ban cancels**, in the same transaction, the account's bookings in its scope that have not started (pending or confirmed), through the staff's own cancel — `StaffBookingsService.cancelByStaffInTx`, split out of `cancel` — so each is cancelled by the staff member with the reason `facility_ban`, points at the ban (`bookings.ban_id`, a CHECK ties the two) and its booker is told (`booking.cancelled_by_staff`). `facility_ban` is a staff reason only a ban gives; it is not on the dashboards' list. The ban's response and its audit (`facility_ban.started`) list `cancelledBookingIds`, ids only.
- **One ban not lifted per account and scope** (a unique key over the facility, or none): one in force is `409 FACILITY_BAN_EXISTS {banId}`; one that has ended is lifted by the system (`ended`, by nobody) when the next one starts, under the account's lock. A ban on one facility and one on all are two scopes.
- **Lifted once** with a `facilityBanLift` reason while in force (`409 FACILITY_BAN_OVER {state}` after). The account is told of both (`facility_ban.started {scope, until?}`, `.lifted {scope}`, category `bookings`), never the reason.
- **What it stops:** booking only. Walk-in use and club memberships are untouched.
- **The booker** sees their bans in force (`GET /me/facility-bans`), and every one of theirs in their personal-data export (`facilities/bans.json`: scope, reason, last day, state; never who gave it).
- Bans are never deleted (a trigger keeps the account, scope, reason and end).

### Facility use

- `GET /staff/facility-usage?from&to` and `/export` (CSV): for each bookable facility over the period (30 days ending today by default, a year and a day at most), computed on read:
  - bookings by status, by the day they start;
  - **open minutes:** the slots its hours offered each day, minus any slot a closure in force overlaps;
  - **booked minutes:** the pending, confirmed and no-show bookings' minutes, each a place (a person, for a facility counted by people);
  - **use** = booked ÷ (open × capacity); **no-show rate** = no-shows ÷ (confirmed + no-shows); **peak share** = held bookings at peak times ÷ held bookings — whole percent, null with nothing to divide.
- Its path is not under `/staff/facilities`, where `:id` would take `usage`. Its period is a query of its own (the same rules as the economics reports'): facilities reads no domain but community (ADR 0044), so it cannot use maintenance's `PeriodQueryDto`.

### Work permits

- **Hazards:** `hot_work | height | live_electrical | confined_space | pool_chemicals` (`workHazard`). A ticket category's work (`requires_permit`, set with `maintenance.manage`) and an asset type's (set with `assets.manage`) may need a permit for some; a ticket needs every hazard of its category and of its asset's type.
- **A permit** is the technician's (`POST /technician/tickets/:id/permits`, on their own ticket in their hands, `tickets.work`) for a hazard on the ticket's current cycle, with their precautions and an expiry within 24 hours (`expiresAt`, an instant with its offset). The precautions are their words: audited as changed only, never in a notice. One open (requested or approved) per ticket, cycle and hazard (`409 WORK_PERMIT_OPEN {permitId}`, and a partial unique key).
- **Decided once** by `safety.manage`: approved (before it expires: `WORK_PERMIT_EXPIRED`) or rejected with a `workPermitReject` reason; an approved one revoked once with a `workPermitRevoke` reason (`409 WORK_PERMIT_DECIDED {status}` otherwise). A state shape and a moves-forward trigger, as the quotes' (ADR 0058). The technician is told of each (`work_permit.approved | rejected | revoked`); who decides is told of a request.
- **The start rule:** `assertSafeToStart`, next to `assertQuoteAllowsStart` in `WorkService.moveInTx`, so a visit's arrival is held to it too. Every hazard the work needs has an approved permit of this cycle that has not expired, else `409 WORK_PERMIT_REQUIRED {hazards}`. It holds for a start, and for a **resume after a hold**: a revoked or expired permit stops the work coming back. Work under way when a permit is revoked stays where it is, and the technician is told to stop it safely.
- **Locks:** the ticket (FOR UPDATE), which every permit write takes first, then the permit; a start reads the permits FOR SHARE under the ticket's lock. A decision, a revocation and a start on one ticket go one at a time.
- **Completing** the work closes the cycle's open permits (a completion hook).

### Safety instructions

- A category's instructions are versions (`POST /maintenance/categories/:id/safety-instructions {textEn, textAr}`, `safety.manage`), numbered under the category's lock, never edited.
- Before the work starts or resumes, the technician acknowledges the current version for the ticket's cycle (`POST /technician/tickets/:id/safety/acknowledge {instructionId}`), else `409 SAFETY_ACK_REQUIRED {instructionId, version}`. A version that is no longer current is `409 SAFETY_INSTRUCTION_NOT_CURRENT`.
- **The acknowledgement** stores the SHA-256 of exactly what was shown — the instruction's id, version and both texts — with who, the ticket and the cycle, once (`acknowledgementDigest`, as a checklist run's attestation, ADR 0064). Never changed.

### A technician's incident and SOS

- **Incident:** `POST /technician/tickets/:id/incidents` (`tickets.work`, the ticket in their hands, no shift): an `injury`, a `near_miss` or a `hazard`, with up to five photos (`incident_photo` uploaders gain `tickets.work`). Where is the ticket's: its unit, or the ticket itself for a common area's work (`incidents.ticket_id`; `incidents_where` counts it; the trigger, recreated, keeps it). The incidents' keepers are told as for a guard's report (ADR 0053).
- **SOS:** `POST /technician/tickets/:id/sos {type}`, with no shift. `GuardSosService`'s logic is split into `SosCore` — the open one answered 200, the responders and the management told, an escalation when nobody is there, the reporter's cancel request — under the caller's own locks, in ADR 0056's order: the guard's raise takes their account, their shift FOR SHARE, then the post's emergency lock; the technician, with no shift, their account, then the ticket's (`emergency-ticket`). An emergency comes from exactly one of a unit, a gate, a zone or a ticket, with a shift only for a gate or a zone (`emergencies_origin`); one open per ticket (a partial unique key behind the lock). The responders' view names the ticket and its unit; nobody's family is alerted.
- **A cancel is a request, not a close:** someone under duress can be made to cancel. `POST …/sos/cancel-request` (an `emergencyCancel` code or none) records it once on the emergency (`cancel_requested_at`, `cancel_request_reason`; the trigger keeps them) and tells its responder, or with none yet everyone who was told (`emergency.cancel_requested`, critical). The emergency stays open — a repeat SOS is the same one — until a responder or the management resolves it (`POST /gate/emergencies/:id/resolve`). G8 handles a vendor alarm's "cancelled" the same way, through `SosCore.requestCancelLocked`. A guard's own cancel (ADR 0053) is unchanged.
- The gate reads the ticket through maintenance's index (`MaintenanceGatePort`); maintenance still never imports the gate (ADR 0032).

## Dates and instants

| Field | Kind | Validation |
|---|---|---|
| programs `startsOn`/`endsOn`, copy `startsOn`, items `dueOn`, bans `endsOn` | day | `@IsString() @IsLocalDate()` |
| usage `from`/`to` | day | `@IsString() @IsLocalDate()` (its own query) |
| permits `expiresAt`, incidents `occurredAt` | instant | `@ToInstant() @IsDate()`, offset required |
| `done_at`, `cancelled_at`, `closed_at`, `lifted_at`, `decided_at`, `revoked_at`, `acknowledged_at` | instant | the database's clock, never input |

## Consequences

- A readiness campaign's inspections are ordinary inspections: their sweep, report and findings apply unchanged.
- Bookings cancelled by a ban read `cancelledSide: staff`, `cancelReason: facility_ban`.
- G8 (ADR 0068) runs its alarm escalation through `SosCore`, not a copy of it, and its vendor "cancelled" through the same cancel request.

## Open

- A shared holiday calendar for the programs' days.
- Readiness budgets as board approvals (a later `APPROVAL_TYPES` entry).
- A technician's own list of their incidents (they read the report they made, at its answer).
- Work under way put on hold by a revocation, rather than the technician told.
