# 0076 — Dispatch depth: the management's own work orders, dispatch's close, reopen and resume, the ticket list by building and number, its CSV, the SLA's escalation levels and report, an asset's timeline and warranty claims, and the planned work calendar

**Status:** Accepted · M2-2 · amends ADR 0032 (dispatch's moves on a ticket), 0034 (the SLA's escalation levels), 0064 (a fifth work-order origin; the resident side's rule; an asset's warranty), 0066 (a spike's work order)

## Context

The manager audit of 2026-11-01 (rows MO-3 of operations, group A of assets) found that the management could not open a work order of its own: a ticket needed a resident reporter, and the compound's work orders came only from a plan, an inspection or a technician's field fault. Dispatch could not close a resident's completed ticket, reopen a closed one, or resume one on hold; the ticket list had no building filter, search or export; the SLA had a breach and nothing before it; there was no SLA compliance report; an asset's history was spread over five reads; its warranty had only an end date and no claim; and the plans' dates could only be read plan by plan. The owner approved the plan and every recommendation of the audit (2026-11-01): escalation per priority (the supervisor at 75 % of the target, the manager at the breach, a warning before it) and ad-hoc staff work orders among them.

## Decisions

### The management's own work orders

- **A fifth origin, `staff`** (`tickets_origin_known`, `tickets_origin_shape` recreated): a repair on an asset or a common area, never a resident's ticket. `POST /maintenance/work-orders` for `tickets.dispatch`: `assetId` or `commonAreaId` (exactly one), a category (active), an optional priority (the category's by default), staff's words. It goes through the one work-order path every origin takes (`createWorkOrder`): the asset shared-locked and in service, the ticket where the asset is. Its reporter and creator are the dispatcher who opened it. Dispatched once committed; the SLA measures it (it is a repair). Audited as `ticket.work_order_opened` (origin, asset or area, category key, priority; never the words).
- **For a meter's spike** (ADR 0066), `meterAlertId`: the alert is taken under its row lock first, so a second work order for it waits and is refused (`409 METER_ALERT_HAS_WORK_ORDER`, `params.ticketNumber`). It is acknowledged with it if nobody had (`meter_alert.acknowledged`, `metadata.by = work_order`). Without a place in the body, the meter's asset, else its area; a unit's meter on no asset needs one named (`FIELD_REQUIRED` on `assetId`). `tickets.meter_alert_id` (a staff work order only, a CHECK; one per alert, a partial unique index; fixed, the origin trigger widened).
- **"A device"** is an asset of the register. A gate device or a guard-down wearable (ADR 0057, 0068) is the gate's, which maintenance may not read; its fault is a work order on its asset when it is registered as one.
- **The resident side's one rule** (`ticket-visibility.ts`) gains a branch: a staff work order on an asset in a unit is the household's to see, as a field fault is (the technician has to get in). None other.

### Dispatch's own moves

- **Close for the residents:** `POST /maintenance/tickets/{id}/close`, a resident's completed ticket (`ticketStaffClose`: confirmed by phone, unreachable, left, other). `closed`, a new confirmation status `closed_by_staff` (`tickets_closed_shape` recreated), the code in the status history; the residents are told (`ticket.closed_by_staff`) and may still reopen it in their `reopenDays`; the technician is told. No rating. A compound's work order is accepted instead (`409 TICKET_NOT_RESIDENTS`).
- **Reopen:** `POST /maintenance/tickets/{id}/reopen`, a closed ticket (`ticketReopen`, with words for the thread), within **30 days** of closing whatever the residents' window (`409 TICKET_REOPEN_WINDOW_PASSED`, `params.reopenDays = 30`). The residents' reopen path: `cycle + 1`, back to its technician the first time, to the queue as an escalation after. The residents are told the new status.
- **Resume:** `POST /maintenance/tickets/{id}/resume`, a ticket on hold back in progress in its technician's hands, behind the same gates as their own resume (an approved quote; a permit in force and **the technician's** safety acknowledgement, ADR 0067). They and the residents are told.
- Each under the ticket's row lock, the caller's account shared-locked first; audited by code (`ticket.closed_by_staff`, `.reopened_by_staff`, `.resumed_by_staff`).

### The list by building and number, and its CSV

- `GET /maintenance/tickets` gains `buildingId` (a building of ADR 0072's register: the tickets of its units, and the work orders of the common areas that name it) and `q` (a ticket's number, `MT-000123` or `123`, or the start of a unit's code in any case; LIKE's wildcards are characters). Both paths of the list (the plain page and the SLA-flagged one) read them, the flagged one through one SQL builder now shared with the export.
- `GET /maintenance/tickets/export`: the same filters over the tickets created on a period of the compound's days (at most 366), oldest first, at most 50 000 rows (`EXPORT_TOO_LARGE`), no-store. Codes, numbers and times only; a common area is its code, never its free label.

### The SLA's escalation levels and report

- **At risk:** per priority, `maintenance_sla_settings.at_risk_percent_{normal,urgent,emergency}` (75 by default, 50–95, null for none), set with `PATCH /maintenance/sla-settings/escalation` (`maintenance.manage`, the row locked, audited by priority). A running clock past that share of its target is at risk: the technician holding the ticket and the dispatch (`tickets.dispatch`) get `ticket.sla_at_risk` (or `_emergency`, critical), the number and the clock only, once per clock and SLA cycle.
- **The sweep** `maintenance.sla_at_risk` runs every minute in compounds with the SLA on and not suspended; each clock in a transaction of its own under its ticket's row lock, read again there (met, paused, breached or retargeted meanwhile: left). `ticket_sla_alerts` (append-only, no foreign keys, like the SLA's events) is the "once".
- **So the levels are:** the supervisor (and the technician) at the share; the managers at the breach, as ADR 0034 already tells them. A new share applies to the clocks not yet at risk.
- **The report:** `GET /maintenance/sla-report` and `…/export` (`tickets.dispatch`): the clocks that ended met or breached on a period (at most 366 days), by category key, priority and clock, with the share met, and the totals per clock. A stopped clock is no verdict.

### An asset's record

- **Timeline:** `GET /maintenance/assets/{id}/timeline` (`assets.read`): its events (ADR 0064), its tickets opened (with their origin), completed (what was done, ADR 0065) and closed, the parts issued and returned, the recorded costs (voided ones left out; a part's cost is its movement), the warranty claims opened and decided. Newest first on one keyset of the time and the row's id. Codes, numbers and amounts only.
- **Warranty:** the card gains `warrantyStartsOn` (on or before the end: `ENDS_BEFORE_START`, and a CHECK), `warrantor` and `warrantyCovers` (plain data; sensitive in the audit). `underWarranty` needs it started too.
- **Claims:** `/maintenance/warranty-claims` (`assets.manage`): an asset and, if it came of one, the asset's ticket (`409 TICKET_NOT_OF_ASSET`), staff's words. Made while the warranty runs by the compound's day (`409 ASSET_NO_WARRANTY`; `409 WARRANTY_EXPIRED` with `params.endsOn`); one open per ticket (the ticket's row lock orders two; `409 WARRANTY_CLAIM_OPEN`; a partial unique index backs it). The warrantor's reference while open; decided once under the claim's lock — accepted (with what was recovered), rejected (`warrantyClaimReject`), withdrawn (`warrantyClaimWithdraw`) — and a trigger keeps a decided claim as it is (`409 WARRANTY_CLAIM_DECIDED`).

### The planned work calendar

- `GET /maintenance/plan-calendar` (`assets.read`): over up to 93 of the compound's days, the plans' occurrences already generated (status, work order) and the dates the active calendar plans will still come due on, projected from their next due date (a fixed series' every date; a floating one's next only). A usage plan has no date until its metric says so. At most 2000 dates.

### Nothing for the staff inbox

- None of this phase's items waits for a staff decision, so none is an inbox type (ADR 0073): a warranty claim waits for the warrantor, whose answer the staff only record; a work order is dispatched, not approved; the escalation levels are notices. An inbox type for a claim past an answer date would need that date first (open).

## Deviations for the owner

1. **Staff reopen window:** 30 days from closing, fixed, beside the residents' `reopenDays` setting; not a setting of its own.
2. **A gate device's fault** is not a work-order source: maintenance may not read the gate; a device registered as an asset is.
3. **A staff work order on an asset in a unit is the household's to see** (as a field fault is); the audit's plan named no visibility rule.
4. **The work plan and the impact score** (MO-3's "اعتماد خطة العمل", "ترتيب الأولوية حسب الأثر") are left out of this phase: they wait for the vendors phase (M2-5) and the analytics phase (M2-13).
5. *(Withdrawn: the building filter is the building's id, ADR 0072, now merged.)*
6. **The at-risk notice reaches the technician too**, as the "warning before the breach"; the supervisor level is the dispatch's.
7. **Asset imports don't take the warranty's start, warrantor or cover** yet; the card and its edit do.
8. **The ticket export's dates are the creation days**, not the closing days.

## Consequences

- New tables `ticket_sla_alerts`, `warranty_claims`; new columns on `tickets`, `assets`, `maintenance_sla_settings`; one enum value.
- Migrations 20270223090000 (the enum value), 090100 (staff work orders), 090110 (the closed shape), 090200 (the escalation levels), 090300 (the warranty).
- The manager dashboard: a work order dialog and the list's filters and export; close, reopen and resume on a ticket; the escalation levels; the SLA report; an asset's warranty, timeline and claims; the planned work calendar.

## Open

- A per-role escalation matrix (beyond the supervisor and the managers), and escalation by time after the breach.
- Work plans approved before the work, and the impact score.
- A warranty claim's answer date, and an inbox item for a claim past it.
- A common area's own building id: the filter reaches an area through the name it carries.
