# Dispatch depth: backend notes for the dashboards

What was built for the management's side of maintenance (ADR 0076):
- its own work orders;
- dispatch's close, reopen and resume;
- the ticket list by building and number, and its CSV;
- the SLA's at-risk level and its report;
- an asset's timeline, warranty and claims;
- the planned work calendar.

The design decisions are in [ADR 0076](../../decisions/0076-dispatch-depth.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, lists are `{ "data": [...], "nextCursor" }`, errors carry `code` and `fields[].code`, creates take an optional `Idempotency-Key`. Local days (`YYYY-MM-DD`) are the compound's.

## Work orders of the compound's own

`POST /maintenance/work-orders` (`tickets.dispatch`), answering the ticket's "created" view (`id`, `number`, `status`, `priority`, `createdAt`):

| field | |
|---|---|
| `assetId` or `commonAreaId` | exactly one (`FIELD_NOT_ALLOWED` on `commonAreaId` with both; `FIELD_REQUIRED` on `assetId` with neither) |
| `meterAlertId` | optional: the spike it answers; then the place may be left out (the meter's asset, else its area) |
| `categoryId` | an active category (`404 CATEGORY_NOT_FOUND`) |
| `priority` | optional; the category's by default |
| `description` | 1–2000, staff's words |

Errors: `404 ASSET_NOT_FOUND`, `404 COMMON_AREA_NOT_FOUND`, `409 ASSET_RETIRED`, `404 METER_ALERT_NOT_FOUND`, `409 METER_ALERT_HAS_WORK_ORDER` (`params.ticketNumber`). The alert is acknowledged with it. The ticket's `origin` is `staff`; it is dispatched like any repair.

## Dispatch's moves

| route | from | body | errors |
|---|---|---|---|
| `POST /maintenance/tickets/{id}/close` | `completed`, a resident's ticket | `reasonCode` from `ticketStaffClose` | `409 TICKET_NOT_RESIDENTS` (a work order: accept it), `409 TICKET_INVALID_TRANSITION` |
| `POST /maintenance/tickets/{id}/reopen` | `closed`, within 30 days | `reasonCode` from `ticketReopen`, `reason` (to the thread) | `409 TICKET_REOPEN_WINDOW_PASSED` (`params.reopenDays = 30`) |
| `POST /maintenance/tickets/{id}/resume` | `on_hold` | — | `409 WORK_PERMIT_REQUIRED`, `409 TICKET_INVALID_TRANSITION` |

Each answers 204. A ticket closed for the residents reads `confirmationStatus: closed_by_staff`.

## The list and its CSV

`GET /maintenance/tickets` gains `buildingId` (a building of `GET /buildings`: its units' tickets and the work orders of the common areas that name it) and `q` (1–40: `MT-000123`, `123`, or the start of a unit's code). `GET /maintenance/tickets/export?from&to&…` takes the same filters over creation days (at most 366) and answers CSV (no-store): `number, status, priority, origin, kind, category_key, unit_code, building, area_code, asset_code, technician_id, confirmation_status, cycle, created_at, assigned_at, completed_at, closed_at, cancelled_at`.

## The SLA

- `GET /maintenance/sla-settings` gains `atRiskPercent: { normal, urgent, emergency }` (each 50–95 or `null`). `PATCH /maintenance/sla-settings/escalation` sets any of the three (`maintenance.manage`).
- Notices `ticket.sla_at_risk` and `ticket.sla_at_risk_emergency` (critical) go to the technician holding the ticket and the dispatch, params `ticketNumber`, `clock`, once per clock and cycle.
- `GET /maintenance/sla-report?from&to` (`tickets.dispatch`): `{ from, to, totals: [{ clock, met, breached, metRate }], rows: [{ categoryKey, priority, clock, met, breached, metRate }] }`; `…/export` the rows as CSV.

## An asset's record

- `GET /maintenance/assets/{id}/timeline` (`assets.read`), newest first, keyset-paged: `{ id, at, kind, code, ticketId, ticketNumber, fromValue, toValue, reasonCode, amount, quantity, itemId }`. `kind` is `asset_event`, `ticket_opened`, `ticket_completed`, `ticket_closed`, `part_issued`, `part_returned`, `cost`, `warranty_claim_opened` or `warranty_claim_decided`.
- The asset's card gains `warrantyStartsOn`, `warrantor`, `warrantyCovers` (read and `PATCH`), `ENDS_BEFORE_START` on `warrantyEndsOn` when it starts after it ends.
- `/maintenance/warranty-claims` (`assets.manage`): `GET ?assetId&status`, `POST { assetId, ticketId?, description }`, `GET /{id}`, `PATCH /{id} { reference }`, `POST /{id}/accept { recoveredAmount? }`, `/reject { reasonCode }`, `/withdraw { reasonCode }`. Errors: `409 ASSET_NO_WARRANTY`, `409 WARRANTY_EXPIRED` (`params.endsOn`), `409 TICKET_NOT_OF_ASSET`, `409 WARRANTY_CLAIM_OPEN`, `409 WARRANTY_CLAIM_DECIDED` (`params.status`), `404 WARRANTY_CLAIM_NOT_FOUND`.

## The planned work calendar

`GET /maintenance/plan-calendar?from&to` (`assets.read`, at most 93 days): `{ data: [{ dueOn, planId, title, assetId, assetCode, priority, status, occurrenceId, ticketId }] }`, `status` one of `open`, `done`, `skipped`, `cancelled`, or `projected` for a date still to come.
