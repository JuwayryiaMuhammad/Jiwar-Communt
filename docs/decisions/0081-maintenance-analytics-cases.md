# 0081 — Maintenance analytics and cases: sensitive tickets and the log of their reads, repeat faults and the plan suggestions they make, the complaints map, community cases

**Status:** Accepted · M2-13 · amends ADR 0010 (a new permission), 0032 (who sees a ticket; a ticket's notices), 0064 (the plans' creation in a caller's transaction), 0076 (the list, its CSV, the timeline and the SLA report leave a sensitive ticket out; a staff work order may answer a case)

## Context

The manager audit of 2026-11-01 (MO-4 of operations) found the analytics of maintenance thin: ADR 0065 counts failures per asset, but nothing counts a category's repeat faults per place, nothing turns them into planned work, nothing shows where the tickets are, nothing groups the reports many households make of one problem, and nothing protects a ticket that should not be read by every dispatcher (and no read anywhere is logged). The owner approved the plan and the audit's recommendations (2026-11-01): three tickets of one category at one place within 30 days make a community case, a maintenance setting; a sensitive ticket is a dispatch-set flag, read with a `tickets.sensitive` permission (the manager's), every read logged.

## Decisions

### Sensitive tickets

- **`tickets.sensitive`** (catalogue: staff and manager kinds; the manager's system role by default; the permission sync adds it to existing compounds). `tickets.sensitive` (boolean, `false`) on the ticket.
- **Marking:** `PUT /maintenance/tickets/{id}/sensitivity { sensitive, reasonCode }` (`tickets.dispatch`): to mark, a code from `ticketSensitive`; to clear, from `ticketSensitiveClear`, and the caller must hold `tickets.sensitive` (`403 FORBIDDEN` otherwise). Under the ticket's row lock, the caller's account shared-locked first; already as asked is left alone (204, no entry); audited `ticket.sensitivity_changed` (`sensitive`, the code, the origin). A dispatcher without the permission loses the ticket the moment they mark it.
- **Hidden** from a staff reader without the permission, on every staff path that reads tickets: the dispatch list (the plain page and the SLA-flagged one; a new `sensitive` filter for the holders), the CSV, the staff search, a read by id and every route on it (`TicketAccess.sees`, so assignment, the thread, photos, visits, quotes, parts, permits, costs and checklists alike answer `TICKET_NOT_FOUND`), an asset's timeline (its rows left out, a warranty claim made of it names no ticket), the SLA report, the recurrence report, the complaints map, a case's tickets and its count, the operations dashboard's counts and its brief (ADR 0079), and a unit's correspondence (ADR 0080, its appearance logged). A sensitive ticket never makes a case or a suggestion, and does not count towards one.
- **Kept** by its technician (their own work: their list and reads, whose views carry `sensitive` so the app says the access is logged) and by the residents it is theirs (their reach is unchanged; their views say nothing of it). The dispatch's views carry `sensitive` too, for the holders.
- **Notices:** of a sensitive ticket, the staff told are its technician and the holders of `tickets.sensitive` (`TicketNotices`, both of its paths); the residents as before.
- **The log:** every staff read of a sensitive ticket is a row of `ticket_sensitive_reads` (`via`: `detail` — a load by id, a write too —, `list`, `export`, `search`), append-only, no foreign keys. Read by the holders: `GET /maintenance/tickets/{id}/sensitive-reads` (`tickets.dispatch` + `tickets.sensitive`), newest first, with the reader's name. A resident's read is not logged.
- **No query on every request:** whether the caller holds the permission is the role's set, cached by its version (ADR 0010), asked only where a list or a sensitive ticket needs it; the guard is unchanged.

### The analytics' numbers

- On `maintenance_settings`: `recurrence_min_tickets` (3, 2–20), `recurrence_window_days` (90, 7–366), `case_min_tickets` (3, 2–20), `case_window_days` (30, 1–180). `GET/PATCH /maintenance/settings/analytics` (`maintenance.manage`), the row locked, audited `maintenance.analytics_settings_changed` (changes). A new number applies to the next ticket that lands.

### When a ticket lands

- In the transaction that writes it, after its row and its number (`TicketsService.insert`, the one path every ticket takes), `TicketLanding` runs. The ticket counter's row, locked by the number's upsert, is held to the commit: two tickets landing together are taken one after the other, and the second reads the first's commit. So a case opens once and a suggestion is made once; partial unique indexes back both (mapped in `db-constraints`). Lock order: the counter, then a case.
- Not for a plan's own work order or a check-up.

### Repeat faults and plan suggestions

- **`GET /maintenance/recurrence?from&to&by&categoryId&min`** (`tickets.dispatch`, at most 366 of the compound's days): per place (`asset`, `unit`, `building` — its units' —, `common_area` — its own and its assets'), per category, from `min` (2–50; the compound's `recurrence_min_tickets` by default) on: the count, the first and the last, the mean gap in days, the recorded cost (voided entries left out), the count per month. Repairs only; a plan's own work orders, check-ups and cancelled tickets are not faults. At most 500 rows (`truncated`). Aggregated in SQL.
- **A suggestion** (`maintenance_plan_suggestions`): at landing, a repair on an asset of a common area (else in a unit: an asset in a unit takes no plan, ADR 0064, so its unit is the place) whose category has `recurrence_min_tickets` there within the window. None while one is open for the place and category, and none for a window after one was decided. Whoever keeps the plans (`assets.manage`) is told (`maintenance.plan_suggested`, needs a decision).
- **Decided once** under its row lock, the caller's account first: `POST /maintenance/plan-suggestions/{id}/accept` with `plan` (a new plan by the plans' own rules and audit, in the same transaction — `PlansService.createIn`; the suggestion's asset when it names one, `409 PLAN_NOT_OF_ASSET` otherwise; its category by default) or `planId` (an active plan of the asset, any for a unit's, that covers it; nothing of the plan changes), or `…/dismiss { reasonCode }` (`planSuggestionDismiss`). `409 PLAN_SUGGESTION_DECIDED` (`params.status`) after; a trigger keeps a decided one as it is. Audited `plan_suggestion.accepted` (the plan, whether made for it, the count) and `.dismissed` (the code). Nothing changes a plan by itself. `GET /maintenance/plan-suggestions[?status]` and `/{id}` (`assets.read`).
- **In the staff inbox** (ADR 0073): an open suggestion is the type `plan_suggestion`, for `assets.manage` (the accept route's permission), due in 72 hours; no bulk approval takes it (its acceptance takes a plan). Both inbox CHECKs are recreated with every type before it in 20270420090400, dated after the common-area uses' (20270420090300) so it is applied last whichever order a database met them in.

### The complaints map

- **`GET /maintenance/complaints-map?from&to&categoryId`** (`tickets.dispatch`, at most 366 days): per building of the register (ADR 0072) its units' tickets — the total, the open ones, the residents', the five categories with the most — at its common area's position (kind `building`, its name) when it has one; per common area with tickets, its own and its assets', at its position. Cancelled tickets are left out. Ids, codes, names of places and counts: never a unit, a ticket or a person, so a bubble opens the ticket list's own `buildingId` filter.

### Community cases

- **Opened by itself:** at landing, a resident's repair in a unit of a building (`units.building_id`). An open case of its category and building takes it (the reporter told, `ticket.case_linked`); else, once the building has `case_min_tickets` residents' repairs of the category within `case_window_days` (none cancelled, none sensitive, none in a case yet), a case opens with all of them: audited `maintenance_case.opened` (the category's code, the building, the count, the ticket that tipped it, `by: threshold`), the dispatch told (`maintenance_case.opened`, the code and the count), each reporter told.
- **`maintenance_cases`** (one open per category and building, a partial unique index) and **`maintenance_case_tickets`** (a ticket in one case, ever: its key; never changed; made to an open case only, an after-insert trigger behind the case's row lock). The building has no foreign key: a building is deleted once its units have left it (ADR 0072), and its cases keep its id.
- **Its one work order:** `POST /maintenance/work-orders` with `caseId` (ADR 0076's path; on an asset or a common area): once the ticket is written, the case is locked, still open and without one (`409 MAINTENANCE_CASE_CLOSED` with `params.status`, `409 MAINTENANCE_CASE_HAS_WORK_ORDER` with `params.ticketNumber`), and takes it; `ticket.work_order_opened` carries `maintenanceCaseId`.
- **Closed once** under its row lock, the caller's account first: `POST /maintenance/cases/{id}/resolve { reasonCode }` (`maintenanceCaseResolve`; each resident reporter of its tickets told, `ticket.case_resolved`) or `…/dismiss` (`maintenanceCaseDismiss`; nobody told). Audited with the code and the count. A case closes none of its tickets: each keeps its own course. Its tickets stay in it, so a new case counts afresh. `GET /maintenance/cases[?status&buildingId]` and `/{id}` (`tickets.dispatch`).

## Deviations for the owner

1. **Marking needs `tickets.dispatch`, clearing `tickets.sensitive`.** The audit said "a dispatch-set flag"; a supervisor may mark one (and loses it), only a holder undoes it.
2. **`tickets.sensitive` may be given to a staff role.** The manager's by default, as the audit said; a compound may give it to its supervisor role.
3. **What a sensitive ticket leaves:** the ticket and every list of tickets, the search, the export, the timeline, the SLA report and the analytics. Lists of other records that name a ticket by its number — part requests, quotes, work permits, warranty claims, replacement recommendations, plan occurrences, visits — and their notices (a work permit's) keep naming it; the ticket itself does not open. An asset's economics (ADR 0065: its costs, failures, MTBF) and the technicians' stats keep counting it: they are the asset's and the technician's record.
4. **Every staff load is a logged read**, a write's too (it reads the ticket); a refused read is not.
5. **A case's place is a building** (its units'). A resident's common-area ticket has only free words for its place (ADR 0076's open item), so it never makes or joins a case; the compound's own work orders never do either.
6. **Tickets join a case by themselves only**; the dispatch neither adds nor removes one by hand. A case closes none of its tickets.
7. _(Withdrawn by the owner, 2026-11-03: a plan suggestion is a staff inbox type, see above.)_
8. **A unit's suggestion takes a plan on an asset of a common area** (an asset in a unit takes no plan, ADR 0064), or is dismissed.
9. **The service-standards drift** (MO-4's `maintenance_standards`: targets for MTTR, reopen rate, rating, SLA % and an alert) is not in this phase: the plan's M2-13 row does not name it.
10. **The four numbers** are the "three numbers" of the plan (3 tickets, 30 days, and the recurrence threshold) plus the recurrence window, all compound settings.

## Consequences

- New tables `ticket_sensitive_reads`, `maintenance_plan_suggestions`, `maintenance_cases`, `maintenance_case_tickets`; new columns `tickets.sensitive` and four on `maintenance_settings`.
- Migrations 20270330090000 (sensitive tickets), 090100 (the settings), 090200 (suggestions), 090300 (cases), and 20270420090400 (the inbox type).
- The manager dashboard: "Repeat faults" with the suggestions, "Complaints map", "Community cases" and a case's page; a ticket's sensitivity and its reads; the four numbers in Maintenance setup → SLA.

## Open

- Retention of the reads' log, and the log in a staff member's own data export.
- A case's manual grouping.
- The service standards and their drift alert.
- A drawn map (the dashboard shows the counts and positions as a table and bubbles).
