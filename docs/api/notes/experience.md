# Experience and recovery (ADR 0082)

The staff's with `experience.manage`, under `/staff/experience`; a compensation's decision with `experience.compensate` (the manager, never a deputy).

## A low rating says why

`lowReasonCode` from `lowRating` goes with a rating of 1 or 2 (optional until the resident apps ship the picker), and is refused (`FIELD_NOT_ALLOWED`) on 3 to 5:

- `POST /tickets/{id}/confirm`, for `rating` (not `technicianRating`);
- `POST /management-requests/{id}/rating`;
- `POST /partner-requests/{id}/rating`, for `stars`.

The ratings' views carry `lowReasonCode` (null on a higher rating, and on ratings given before).

## Signals

- `GET`/`PATCH /staff/experience/settings`: `{ rules: [{ code, count, days }] }`.
  - `repeated_low_ratings` 2 in 90 days, `reopened_tickets` 2 in 60, `repeated_complaints` 3 in 30.
  - `count` 2–20 or null (off), `days` 7–365.
  - A PATCH takes `items` (a code at most once).
- `GET /staff/experience/signals?unitId&code`: newest first.
  - Each signal has the unit (code and building), the rule, how many events in how many days, and its case.
  - Written by the sweep `experience.signals` (every 15 minutes), once per a unit's newest event.

## Cases

- `POST /staff/experience/cases { unitId, kind, sourceType?, sourceId?, failureCode?, note?, ownerId? }`:
  - `kind` is `follow_up` or `recovery`;
  - `sourceType` and `sourceId` come both or neither;
  - `failureCode` is from `creditNoteCompensation`.
  - Refusals: `409 EXPERIENCE_CASE_OPEN { caseId }` when the unit has an open case, `404 UNIT_NOT_FOUND`, `409 EXPERIENCE_OWNER_INVALID`.
- `GET /staff/experience/cases?status&kind&unitId&ownerId`, `GET …/{id}` (with `signals` and `compensations`).
  - `number` is `EC-000123`.
  - `dueAt` is the opening plus the inbox's hours for `follow_up_case` (72) or `recovery_case` (24); null once closed.
- `POST …/{id}/assign { ownerId }`: the owner is told `experience_case.assigned`.
- `POST …/{id}/close { outcome, note? }` (`experienceCaseOutcome`), once.
  - `409 EXPERIENCE_CASE_COMPENSATION_PENDING` while a compensation waits.
  - `409 EXPERIENCE_CASE_NOT_COMPENSATED` for `compensated` with none approved.
  - `409 EXPERIENCE_CASE_CLOSED` once closed.

## Compensations

- `POST /staff/experience/cases/{id}/compensations { kind, failureCode, amount?, note? }`:
  - `kind` is `credit`, `apology`, `redo` or `priority`;
  - `amount` is required on a credit and refused otherwise.

  The holders of `experience.compensate` are told (`experience_compensation.proposed`, `needsDecision`).
- `GET /staff/experience/compensations?status&caseId` (oldest first), `GET …/{id}`. A proposed one has `authority { threshold, binding, decider }`: `board` above a binding `compensation_above_limit` threshold.
- `POST /staff/experience/compensations/{id}/decide`:
  - `{ decision: 'reject', reasonCode }` (`compensationReject`);
  - `{ decision: 'approve' }` for an apology, a redo or a priority;
  - `{ decision: 'approve', invoiceId, authorizationId? }` for a credit.
  - A credit is ADR 0058's compensation credit note on the unit's invoice (the unit told `compensation.granted`).
  - Above the binding threshold it names what the board approved. The manager first raises `POST /staff/governance/approvals { type: 'compensation_above_limit', cost }`, then lists `GET /staff/finance/board-authorizations?type=compensation_above_limit&unused=true`.
  - Refusals: `409 NEEDS_BOARD_APPROVAL { type, limit }`, `BOARD_AUTHORIZATION_USED`, `…_EXCEEDED`, `…_NOT_FOUND`, `FIELD_NOT_ALLOWED` within the threshold.
  - Once: `409 COMPENSATION_DECIDED { status }`.
- `GET`/`PUT /staff/experience/compensation-rules { items: [{ failureCode, kind | null, amount? }] }`: what is recommended per failure; `kind: null` removes it.
- The governance settings (`/staff/governance/settings`) have a `compensation_above_limit` row, `bindable` and binding by default, with no threshold until set.

## Promises and reports

- `GET /staff/experience/promises?active`, `POST …`, `PATCH …/{id}`. The body is `{ titleEn, titleAr, metric?, target?, targetShare?, active? }`:
  - an hours metric (`ticket_resolution_hours`, `request_response_hours`) takes `target` 1–8760 and `targetShare` 1–100;
  - a rating metric takes `target` 1–5 and no share;
  - no metric takes neither.
- `GET /staff/experience/promises/report?from&to`: `{ from, to, items: [{ promise, measured, items, value, met }] }`.
- `GET /staff/experience/ratings-report?from&to`: `totals`, `bySource`, `reasons` (`code`, `count`, `share`), `unstated`, `byBuilding`, `units` (repeated low ratings).
- Both reports take the compound's days, 30 by default and at most 366 (`PERIOD_TOO_LONG`).
- `GET /board/overview` gains `sections.experience`: totals only, never a unit.
