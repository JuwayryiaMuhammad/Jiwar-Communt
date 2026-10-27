# 0064 — The compound manager's assets: the register, its common areas and documents, the compound's own work orders, versioned checklists, maintenance plans, field inspections, and the technician in the field

**Status:** Accepted · M1-1 · amends ADR 0032 (tickets: an origin), 0033 (dispatch: work orders through the same engine), 0034 (the SLA: no clock on a planned job), 0038 (preventive check-ups stay the household's), 0029 (three file purposes)

## Context

The roles' list gives the compound manager an asset register, preventive maintenance, field inspections, spare parts, asset economics, facilities, energy and seasonal readiness; the technician preventive tasks, checklists, offline work, safety and performance. Until now maintenance knew only residents' tickets, dispatch, visits, the SLA and quotes (ADRs 0032–0034, 0038, 0058). `src/maintenance/preventive` holds check-ups a household books once (ADR 0038). The flow says "no recurring schedule, no reminder". Nothing modelled an asset, a schedule, a checklist or an inspection. Common areas were a free-text label on a ticket ("until common areas have a table"), buildings the units' `building` text.

M1 is split into three phases, each from main after the one before it merges:
- **M1-1 (this ADR):** the register, work orders, checklists, plans, inspections, the technician's field routes and their pages.
- **M1-2 (ADR 0065):** stock, costs, economics and KPIs.
- **M1-3 (ADR 0066):** energy, readiness and seasons, facility usage and safety.

Technician offline is its own phase (O2). O1's offline is the gate's in every layer, so O2 would first move its envelope, signer and replay guard into core. M1's technician writes are idempotent already, and every time they take carries its offset.

## Decisions

### Common areas

`common_areas` holds the places of the compound that are not a unit. There are three kinds:
- **building:** a building as a whole. Its `building` is the units' own text, with one row per building.
- **area:** a garden, a roof, a pump room. It may name the building it is in.
- **facility:** one of the facilities (ADR 0044), at most one row each. It is joined by a composite foreign key: maintenance never imports the facilities domain, and an unknown facility is `RELATED_RESOURCE_MISSING`.

A common area has a code unique per compound, Arabic and English names, and an optional position. It is never deleted; retired, it takes nothing new.

Zones (`places`) are the gate's, and maintenance never imports the gate, so an area names its building rather than a zone.

### Tags

A tag is `JWA1.<assetId>.<token>` on an asset and `JWL1.<areaId>.<token>` on an area. Both prefixes are apart from every other prefix the apps scan (JWC1, JWK1, JWP1, JWR1).
- The server keeps the token's SHA-256 only, labelled per kind, with no key. Rotating a key must never kill printed tags.
- A tag is issued under the row's lock and shown once, `no-store`, and is not replayed by an idempotency key. The previous print dies in the same commit.
- An old print, another place's tag and a malformed code all get the same answer: `TAG_NOT_RECOGNIZED`, and for an inspection `INSPECTION_TAG_MISMATCH`.

### The asset register

`asset_types` is seeded per compound (a provisioner, and a per-tenant backfill). Each type names the ticket category whose technicians work on it, so the dispatch engine needs nothing new, and has an expected life.

`assets`:
- **Place:** in a unit or a common area, never both. A part names its parent and is where its parent is, four levels deep at most (building → system → asset → component).
- **Plain facts:** the vendor's name and phone, the warranty, the purchase and replacement values, the downtime cost a day, what it serves (buildings). None of these is ever in the audit trail as text.
- **Status and condition:** in service, out of service (a reason code) or retired (a reason code, for good, parts first). The condition is good, fair, poor or critical.
- **Fixed by trigger:** a code, a type, a parent and a retirement are kept by a trigger.
- **Health** is a rule, read with the card. It starts at 100 and loses for the condition, for being out of service, for age against expected life, for open corrective tickets and for overdue planned work, giving a score and a band. **Impact** is the units, and occupied units, of the buildings the asset serves or stands in: counts only.

`asset_events` is the asset's own history, append-only, in codes. An update names the fields that changed, never their values.

**Moving:** a root asset moves with its whole subtree, under row locks (root first, the rest by id). A part is created under its parent's shared lock, so it never lands where its parent no longer is.

**Warranty notices:** a sweep tells who keeps the register, once per end date, that a warranty ends within 30 of the compound's days.

**Documents** (`maintenance_documents`) belong to an asset, an asset type or an area:
- They are plans, manuals, warranty cards and certificates, read through presigned URLs (`no-store`) by every `assets.read` holder.
- Fifty may live per subject. The subject's row is locked FOR NO KEY UPDATE before the count, so parallel adds cannot pass the cap.
- A document is removed once; its row stays and its file goes.

**CSV import** (`asset_imports`) is two steps:
- **Check:** the sheet is parsed whole (`parseCsv`: strict UTF-8, no control bytes, RFC 4180, 1 MB, 2000 rows). Every problem is kept as `{ line, field, code }`, the first 100 of them, never a cell's text. A sheet that is not clean CSV is refused at the upload (`422 ASSET_IMPORT_UNREADABLE`) with no import left.
- **Apply:** a valid import is checked again under the locks the inserts need (the areas and parents it names, shared), then creates every row or none. Whatever changed since the check makes it invalid instead. It applies once.

### The compound's own work orders

A ticket now has an `origin`: `resident` (every ticket until now, by default), `plan`, `inspection` or `field`. A staff-origin ticket names its asset, or, for an inspection's finding without one, its area. A trigger keeps the origin, the asset and the area.

A work order keeps every column a resident ticket has, so an app rolled back past this phase still reads it:
- its reporter and creator are the staff member who answers for it (the plan's owner, the inspector, the technician who found the fault);
- in a common area, its `common_area` label is the area's English name, written once beside the area's id.

It goes through the existing insert and the existing dispatch engine (`TicketsService.createWorkOrder`, then `dispatchAfterCommit`, or the plan sweep's own pass).

Dispatch accepts the completed work or sends it back (a reason code, and the note in the thread for the technician), as a resident confirms or rejects theirs. A resident's ticket answers `409 TICKET_NOT_WORK_ORDER`.

What does not apply to a work order:
- **Quotes:** refused with `409 TICKET_QUOTE_NOT_ALLOWED`. The work is the compound's cost.
- **Resident escalation:** never.
- **SLA clocks:** a planned job has none (it has a due date and a grace). A field fault and a finding have the SLA.

The dispatch list filters by origin and asset.

### One rule for the resident side

`ticket-visibility.ts` writes the rule once, as a list read into both a database filter and a check:
- every resident ticket (its usual reach then applies);
- a technician's field ticket on an asset in a unit, for that unit's household. They have to let the technician in, so they see it and its visits;
- no other work order of the compound's.

It is ANDed into `residentTickets()`, which serves every resident list: the resident's tickets, the feed and "my requests" and their search, and the daily brief. It also applies to:
- the resident read (`TicketAccess`, and so the timeline, photos, messages, quotes and escalation);
- a household's way to visits (`VisitAccess`, before the consenter's shortcut) and the unit's visits list;
- the visit notices' recipients.

Every resident notice is sent to `residentReporter(ticket)`, which is nobody for a work order. The "reporter who left" filter ignores a work order's staff reporter, and the thread's readers are `residentParties(ticket)`.

The personal-data export takes `residentPartyOf(account)`: a resident's own tickets, never a work order, so a staff member's export holds no work record.

The household of a field ticket in its unit sees it and its visits, but does not confirm, rate, cancel or escalate it: those stay the compound's.

### Checklists

`checklist_templates` have a purpose (`pm`, `inspection`, `any`), may require a tag scan, and carry versioned items:
- **Items** are a check (pass, fail, n/a), a reading (a metric key, a unit, a range: out of it fails), a photo or a note. They are never edited: replacing them is a new version under the template's lock, and an open run keeps the version it took.
- **Follow-ups:** a failing check or reading may ask for a follow-up, with its category and priority.

**Runs:** a run is a ticket cycle's or an inspection's, never both. It is answered item by item while open (three photos an answer), under the subject's lock and then the run's. It is submitted once, with every required item answered (`409 CHECKLIST_INCOMPLETE` names the positions).

**Attestation:** the run stores the SHA-256 of its canonical form: who submitted it, when, and every answer by position with its photos' file ids. That is the inspector's digital signature. A trigger freezes the run and its answers (an erasure may still null who answered). A ticket is not completed while its run is open (`409 CHECKLIST_NOT_SUBMITTED`, a completion hook).

**Readings:** a submitted run's readings land in `asset_readings`, append-only, and a technician may enter readings by hand. Each reading carries an occurrence time with its offset, within 30 days and never ahead but by five minutes.

### Maintenance plans

`maintenance_plans` holds an asset's planned work. Its work orders go to its category (the type's by default), carry its checklist, and have its owner (an active dispatcher) as reporter. A plan comes due in one of two ways:
- **On the calendar:** every N days, weeks, months or years from an anchor. **Fixed** plans keep their own dates (a month's step keeps the anchor's day, clamped to the month's last, never drifting). **Floating** plans count one interval after the day the work ended.
- **By usage:** when a metric's readings grew by an interval since the last service.

Each due date opens one occurrence (`maintenance_plan_occurrences`) and its work order, `lead_days` before:
- **Once only:** generation takes the owner's account (shared), the asset (shared) and the plan (for update), in that order, and decides after the locks. A unique index on the plan and the original due date backs it, so two sweeps, or a sweep and a reading, open one.
- **Dispatch:** the plan sweep offers the work order to the engine in a transaction of its own. A usage plan's waits for the dispatch sweep, since the reading's transaction is still open.

**Completion** (a hook under the ticket's lock) marks the occurrence done. It is on time when completed by `due_on + grace_days`, on the compound's calendar. A cancelled work order ends its occurrence. Floating plans then count from that day.

**Overdue:** past the grace, the owner and every dispatcher hear once.

**Deferring and skipping:** a due date not yet opened is moved (`planDefer`, within a year) or skipped (`planSkip`, recorded as an occurrence). An open occurrence's due date is moved too, and may be told of again. A plan is turned off with a reason and on again re-timed from today.

**What ends or refuses a plan:**
- Retiring an asset ends its plans, in the same transaction (an asset hook).
- An asset in a unit takes no plan (`409 PLAN_FOR_UNIT_ASSET`). The household books its check-ups (ADR 0038); a "your check is due" nudge is Open.

`maintenance_plan_events` keeps what happened, append-only. A closed occurrence never changes.

There is no holiday calendar: due dates are the compound's days and are not shifted. A shared calendar that would absorb `permit_settings.days_off` comes later.

### Field inspections

`inspection_rounds` is a fixed series on the calendar with a checklist (`inspection` or `any`), a target (an asset not in a unit, or a common area) and an inspector (an active `inspections.perform` holder). Its sweep opens one inspection per due date, `lead_days` before, once per round and date. One may also be scheduled on its own. The inspector is told, and past its day the inspector and who manages inspections are told once.

The inspector:
1. **Starts it:** with the target's current tag scanned when the checklist asks. The scan may also come later, before submitting.
2. **Answers its run.**
3. **Submits it once:** each failing item that asks for one opens one follow-up work order (origin `inspection`), for the asset or the area, with the item's category and priority and the inspector as reporter, offered to dispatch after commit. `inspection_findings` keeps the links.

An inspection is called off with a reason. A submitted or cancelled one never changes.

The report counts a period's inspections by due date: done, on time (submitted by their day), open, overdue, cancelled, failed items, and findings closed of all (the closure rate). It is JSON, and CSV through `toCsv` (every text cell defused against formulas: `= + - @`, tab, CR), downloaded through the BFF. It carries codes and ids only.

### The technician in the field (`assets.read`)

- **Scanning a tag** opens the asset's card or the area and is kept (`field_scans`), sixty scans a minute.
- **The asset's card** shows its last 20 events and each metric's last reading beside the one before.
- **Readings by hand** may make a usage plan come due.
- **A fault found on site** is a field work order on the asset, in its place and its type's category, with report photos.
- **A recommendation to replace** (`replacementReason`): one waits per asset, under the asset's row taken FOR NO KEY UPDATE first, and is decided once by who keeps the register (accepted, or declined with `replacementDecline`). Both land in the asset's history.
- **Upcoming planned work:** the calendar plans due within 30 days in the technician's trade (their specialties' categories), and their open planned work orders.
- **The technician's list** may be sorted most urgent first (`sort=priority`, a keyset of its own on rank, time and id).

### Permissions and pages

| Permission | Who | Grants |
|---|---|---|
| `assets.read` | technician, supervisor, manager | the register, plans and checklists |
| `assets.manage` | supervisor, manager | keeping them |
| `inspections.perform` | technician | performing inspections |
| `inspections.manage` | supervisor, manager | scheduling them and the report |

The manager dashboard gains:
- pages for the assets, the common areas, planned maintenance, the inspections (with their rounds and report) and the replacements;
- asset types and checklists in the maintenance setup;
- a work order's card on the ticket's page.

## Lock order (new paths)

- **Everywhere:**
  1. accounts (shared: the caller, an owner, an inspector);
  2. the asset or the area (shared, or FOR NO KEY UPDATE for a count that caps);
  3. the plan or the round (for update);
  4. the occurrence or the inspection;
  5. the run.
- **A move:** the root, then its subtree by id.
- **Hooks that run under a ticket's lock** (completion, cancellation, readings) take the plan before its occurrence. Nothing takes a ticket after a plan, so no cycle forms.

## Privacy

- **Audit:** codes, keys, ids, days and amounts only. The names, a title, a note, the vendor's name and phone and a serial number are recorded as `{ changed: true }`. A tag and a cell's text are never recorded.
- **Notifications:** an asset's or an area's code and a day only, never a name.
- **Import problems:** a line, a column and a code.
- **Reports and their CSV:** codes and account ids, no one's name.

## Consequences

- **Rollback:** a rolled-back app reads a work order as a ticket reported by staff. It would show it in no resident list, because residents' lists ask for their own accounts and units and a work order on a unit exists only for a field fault.
- **Dispatch:** work orders reach the technicians who already hold the category's specialties. The engine, the SLA and the visits did not change.
- **Imports:** a sheet is read whole by the server, at most 1 MB, and never served back.

## Open

- A holiday calendar, and due dates shifted off its days.
- A nudge to a household that its asset's check-up is due.
- Linking a facility closure for maintenance to its work order.
- Technician offline (O2).
- The field-team phase: shifts and attendance, broadcasts with acknowledgement, certifications, help requests.
- The capital plan that takes an accepted replacement up (M1-2), and its board approval (ADR 0055).
- A drawn signature. The run's attestation is the inspector's, and the household's in-app confirmation is theirs.
