# 0087 — Compliance and safety: a compliance calendar of what the compound keeps valid, corrective actions an incident does not close without, safety KPIs over a year, drills as a readiness kind, and a lockdown from the office

**Status:** Accepted · M2-6 · amends ADR 0053 (who may start a lockdown; an incident's close waits for its corrective actions; the incidents report covers a year), 0055 (a `compliance` section in the board's overview; security's section gains the safety KPIs), 0067 (a readiness item may be a drill), 0077 (the vendors' papers read into the calendar)

## Context

The manager audit (2026-11-01) found no compliance calendar: readiness programs (ADR 0067) and maintenance plans (ADR 0064) are calendars of work, not of obligations, and nothing kept a fire certificate, a lift licence, an insurance policy or a permit with its due day, who answers for it and its evidence. An incident closed whatever its investigation decided must still be done. The incidents report stopped at 31 days and counted no safety observations. Drills had no place but a lockdown's `drill` reason. Only a guard on shift could start a lockdown, though the journey gives the manager the red button. The owner approved the plan and every audit recommendation (2026-11-01): a lapse blocks nothing (notices and a red state); corrective actions block the close; safety reports up to 366 days; drills as a readiness item kind with an outcome and a headcount; the manager may start a lockdown with the same typed confirmation.

## Decisions

### Permissions

- `compliance.manage` (the manager; a compound may give it to a staff role, the maintenance supervisor's say): the calendar, its items, due days, evidence, report and lead times.
- `lockdown.start` (the manager kind only, so the manager role only): a lockdown from the office. `lockdown.end` is unchanged.
- Corrective actions are kept with `incidents.manage`; an action's owner marks their own done with no permission (`/staff/incident-actions`), as a readiness item's owner does (ADR 0067). A resident is refused (403).
- The safety KPIs read with `incidents.manage` or `guard_reports.read`, as the incidents report.
- The permission sync brings both new permissions to existing compounds' manager roles; nobody else gains one.

### The compliance calendar (`src/maintenance/compliance`, migrations 20270518090000–090200)

- **An item** is what the compound keeps valid: a kind (`fire_system`, `lift`, `insurance`, `licence`, `permit`, `other`), a title (the compound's words), the authority that issues it and its reference, what it is about (an asset of the compound's own, not a unit's and not retired; an active common area — buildings are common areas; or nothing: the compound), and who answers for it: a vendor of the register (ADR 0077; a suspended one is refused, `VENDOR_SUSPENDED`), an active staff member or the manager (`RESPONSIBLE_NOT_ELIGIBLE`), or both — at least one. Every 1 to 120 months, or once. Never deleted: retired once with a `complianceRetire` code, which calls off its open due day.
- **Due days** (`compliance_occurrences`): one open at a time (a partial unique index behind the item's lock). The first is made with the item, from today, ten years ahead at most. **Done once**: on a day not after today and a year back at most, with what it gave (a certificate's number, its expiry after that day), a note about the work and evidence files. The next due day is made in the same transaction: the day given, else that expiry, else so many months after the day just done (the same day of the month, or the last of a shorter one); none for an item done once with nothing that expires. A PATCH may move the open day (the authority gave another); its notices start again.
- **Evidence** (`compliance_evidence`, file purpose `compliance_evidence`, a photo or a PDF of 10 MB): filed with a completion or later on an open or done due day, 20 live at most; removed once (filed by mistake), its file marked deleted. The archive is the item's due days, latest first, with their files.
- **States**, on the compound's today: `valid` (the open day beyond the longest lead time), `due_soon` (within it), `overdue` (past it), `completed` (no open day left), `retired`. A lapse blocks nothing.
- **Lead times are settings**: the compound's (`compliance_settings`, one to three of 1 to 365 days, 60, 30 and 7 by default; one row made by its first change, the defaults without it), or the item's own. The sweep `maintenance.compliance` (hourly) tells the responsible staff member and the `compliance.manage` holders each lead time once, the shortest reached (`compliance.due_soon`; never a longer one after a shorter: an item made 20 days ahead is told at 30, then 7), and a passed day once (`compliance.overdue`). The responsible staff member is told an item is theirs (`compliance_item.assigned`). Params are the kind, the day and the days left.
- **The calendar** (`GET /staff/compliance/calendar?from&to`, 90 days by default, 366 at most): the items' due days not called off, and **the vendors' live papers expiring then, read from `vendor_documents` where they are, never copied** (a paper is due soon within the 30 days ADR 0077 announces it). Ordered by day, 1000 entries at most (`truncated`).
- **The status report** (`GET /staff/compliance/report`, `no-store`): per kind in a fixed order with zeros, the items valid, due soon, overdue, done once and retired today, and the vendors' papers valid, expiring and lapsed; one aggregate query each. `GET …/report/export` is one CSV row per item not retired, soonest due first (no staff member's name).
- **The board's overview** gains a `compliance` section (ADR 0055's registry): the report's totals and the vendors' papers, as of today, counts only.
- **Locks:** the caller's account and a responsible staff member's (FOR SHARE), the vendor (shared, usable), the item (FOR UPDATE to change, complete or retire it; FOR SHARE to file evidence, and in the sweep), then its due day (FOR UPDATE). **Two completions of one due day**: the second waits for the item and finds it done (`COMPLIANCE_OCCURRENCE_ENDED {status}`); one next due day is made. A completion and a retirement meet in one order.

### Corrective actions (`src/gate/incidents`, 20270518090300)

- An incident's actions (`incident_actions`, at most 50): what must be done (1 to 1000 characters), its owner (an active staff member or the manager, told: `incident_action.assigned`), a day from today within a year. Changed while open (a new owner told; a later day a new chance to be on time). **Done once** (by its owner or a keeper, with a note of the doer's own) or **called off once** (a keeper, `incidentActionCancel`), never both; then it changes no more (a trigger).
- **An incident does not close while one of its actions is open**: `INCIDENT_ACTIONS_OPEN {open}`. The close takes the incident FOR UPDATE and counts; every action write takes it FOR SHARE first and is refused once it is closed (`INCIDENT_CLOSED`). **A close and a new action meet in one order**: never a closed incident with an open action.
- The sweep `gate.incident_actions` (every 15 minutes) tells the owner and the incidents' keepers once that an open action is past its day (`incident_action.overdue`). Both notices target the incident.
- The keepers' incident view gains `actions {open, done, cancelled}`. The owner's own list shows the incident by its reference, type and severity, never its investigation.
- **Erased** (ADR 0053's rule): the description an account wrote and the done note it wrote go, once, audited by id (`incident_action.text_cleared`). **Exported**: `incidents/actions.json`, the actions it owns, made or marked done, with its own words only.

### Safety KPIs

- `GET /staff/security/reports/safety?from&to` (30 days by default, **366 at most**, the compound's days): the safety incidents (injuries, near misses, hazards, fires, property damage) by when they happened and the last injury's day with the days since; the safety observations (hazards and near misses) reported, closed, their closure rate and mean hours to a close; the corrective actions made in the period, done, done by their day, called off, and all open and overdue now; the drills due on the period's days and done in it, by outcome, with their headcount and mean minutes. Each an aggregate in SQL; counts and rates only. The drills are read through `MaintenanceGatePort.drills` (the gate imports maintenance through its index only).
- **The incidents report and its CSV cover 366 days too**; the violations report keeps 31. The board's overview keeps its 31 days; security's section gains the KPIs of the same days.

### Drills (20270518090400)

- A readiness item of kind **`drill`** with its type (`fire`, `evacuation`, `lockdown`, `medical`, `earthquake`, `other`), which never changes. Done with its outcome (`drillOutcome`: passed, issues found, failed) and how many took part, and its minutes when counted; no other kind takes them (a CHECK). A copied program copies its drills open again. The kind CHECK and the end trigger are recreated with the drill's columns.

### A lockdown from the office (20270518090500)

- `POST /staff/security/lockdowns {scope, gateId?, reasonCode, confirmation: "LOCKDOWN"}` (`lockdown.start`): ADR 0053's start, its rules kept — the same scope, reason codes and typed confirmation, immediate, one live per scope under the compound's lockdown state row, a repeat answering 200 with the live one (whoever started it) and telling nobody again, the same notices (the guards on shift, the `lockdown.end` holders but the starter, every resident on the first) and the control room's event. With no shift: the lock order is the account, then the state row.
- `gate_lockdowns.started_from` (`gate` | `office`, a CHECK: a shift exactly for `gate`); `started_shift_id` becomes nullable and the move-forward trigger compares it as a value that may be NULL. The views and the audit gain where it was started (`from`). Its idempotency replays the management's view (`gate_lockdown_office`).
- **Two starts at once** (the manager and a guard, or two from the office) make one lockdown.

## Deviations for the owner

1. **The responsible staff member is told, but the calendar is kept by `compliance.manage`**: an item's owner has no completion route of their own (an evidence upload needs the purpose's permission). A compound gives `compliance.manage` to the maintenance supervisor when they should record completions.
2. A compliance item's subject is an asset of the compound's own or a common area (buildings are common areas, ADR 0064), not the `buildings` register of ADR 0072.
3. No staff inbox type: nothing in compliance waits for a decision. Overdue items are told and show red; M2-4's dashboard may count them.
4. A completion's note and an item's notes are about the work, never a person: not exported or erased. A responsible staff member is a reference, like a readiness item's owner.
5. The compliance sweep tells the vendor nothing: a vendor has no account (contractor accounts are M2-7's).
6. The board's `compliance` section is as of today, whatever the period asked: an obligation's state is not a period's.
7. The safety observations are the hazard and near-miss incidents; there is no observation record of its own.
8. The incidents report's period widened to 366 days with the KPIs (decision 11); the violations report and the board's overview keep 31.
9. Emergency plans per emergency type (routes, assembly points, responsible staff) are not built: the plan row names drills only.

## Consequences

- **Migrations** `20270518090000` (the file purpose's enum value, alone) to `20270518090500`: the content type CHECK recreated whole with `compliance_evidence`; five new tenant tables under RLS, forced, with composite keys (`compliance_settings`, `compliance_items`, `compliance_occurrences`, `compliance_evidence`, `incident_actions`); readiness items' drill columns; the lockdowns' `started_from`. No row changes. Every new CHECK is on the review list; the new unique indexes are mapped.
- **The races are tested** (×5 rounds): two completions of one due day, a completion against a retirement (`test/compliance/compliance-concurrency`); a close against a new action (`test/security/corrective-actions-concurrency`); two lockdown starts, the manager's and a guard's, and two from the office (`test/security/office-lockdown`).
- **The manager dashboard** gains Compliance (items, an item's archive and completion, retire), the compliance calendar, the safety KPIs, an incident's corrective actions (the close disabled while one is open), My corrective actions, Lock down on the lockdown page, and drills in readiness.
- **The API notes** are in [`docs/api/notes/compliance-safety.md`](../api/notes/compliance-safety.md).
