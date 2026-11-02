# Maintenance analytics and cases: backend notes for the dashboards

What was built (ADR 0081):

- sensitive tickets and the log of their reads;
- the analytics' four numbers;
- repeat faults and the plan suggestions they make;
- the complaints map;
- community cases.

The design decisions are in [ADR 0081](../../decisions/0081-maintenance-analytics-cases.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, lists are `{ "data": [...], "nextCursor" }`, errors carry `code` and `fields[].code`. Local days (`YYYY-MM-DD`) are the compound's.

## Sensitive tickets

| route                                           | permission                                             | body / query                                                                            | answers                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PUT /maintenance/tickets/{id}/sensitivity`     | `tickets.dispatch` (to clear, `tickets.sensitive` too) | `{ sensitive, reasonCode }`: `ticketSensitive` to mark, `ticketSensitiveClear` to clear | 204; `403 FORBIDDEN` (clearing without the permission), `404 TICKET_NOT_FOUND`                                 |
| `GET /maintenance/tickets/{id}/sensitive-reads` | `tickets.dispatch` + `tickets.sensitive`               | `cursor`, `limit`                                                                       | `{ id, reader: { id, fullName }, via, readAt }`, newest first; `via` is `detail`, `list`, `export` or `search` |

- The dispatch's and the technician's ticket views gain `sensitive`. `GET /maintenance/tickets` and its export take `sensitive=true|false`.
- Without `tickets.sensitive`, a sensitive ticket is in no list, search, export, timeline, report, map or case of the reader, and its id answers `TICKET_NOT_FOUND` on every route. Show "Access to this ticket is logged." on one.

## The analytics' numbers

`GET /maintenance/settings/analytics` and `PATCH` (`maintenance.manage`): `recurrenceMinTickets` (2–20), `recurrenceWindowDays` (7–366), `caseMinTickets` (2–20), `caseWindowDays` (1–180); `INVALID_NUMBER` with `params.min`/`max`.

## Repeat faults

`GET /maintenance/recurrence?from&to&by&categoryId&min` (`tickets.dispatch`, at most 366 days; `by`: `asset` (default), `unit`, `building`, `common_area`; `min` 2–50): `{ from, to, by, min, truncated, rows: [{ placeId, placeCode, categoryId, categoryKey, count, firstAt, lastAt, meanIntervalDays, cost, months: [{ month, count }] }] }`, most tickets first, at most 500 rows.

## Plan suggestions

| route                                             | permission      | body                                                                       | errors                                                                                          |
| ------------------------------------------------- | --------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /maintenance/plan-suggestions?status`        | `assets.read`   | —                                                                          | —                                                                                               |
| `GET /maintenance/plan-suggestions/{id}`          | `assets.read`   | —                                                                          | `404 PLAN_SUGGESTION_NOT_FOUND`                                                                 |
| `POST /maintenance/plan-suggestions/{id}/accept`  | `assets.manage` | exactly one of `plan` (the body of `POST /maintenance/plans`) and `planId` | `409 PLAN_SUGGESTION_DECIDED` (`params.status`), `409 PLAN_NOT_OF_ASSET`, the plans' own errors |
| `POST /maintenance/plan-suggestions/{id}/dismiss` | `assets.manage` | `{ reasonCode }` from `planSuggestionDismiss`                              | `409 PLAN_SUGGESTION_DECIDED`                                                                   |

A suggestion: `{ id, assetId | unitId, placeCode, categoryId, categoryKey, ticketCount, windowDays, firstTicketAt, lastTicketAt, status, createdAt, decidedAt, planId, planCreated, reasonCode }`. The notice `maintenance.plan_suggested` (`categoryKey`, `ticketCount`; needs a decision) targets `plan_suggestion`. An open one is in the staff inbox as the type `plan_suggestion` (`assets.manage`, 72 hours; opens "Repeat faults"; never bulk-approved).

## The complaints map

`GET /maintenance/complaints-map?from&to&categoryId` (`tickets.dispatch`, at most 366 days): `{ from, to, buildings: [{ buildingId, name, latitude, longitude, total, open, residents, categories: [{ categoryKey, count }] }], areas: [{ commonAreaId, code, kind, latitude, longitude, total, open }] }`. Open a building with `GET /maintenance/tickets?buildingId=…`.

## Community cases

| route                                         | permission         | body                                           | errors                                                                                       |
| --------------------------------------------- | ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /maintenance/cases?status&buildingId`    | `tickets.dispatch` | —                                              | —                                                                                            |
| `GET /maintenance/cases/{id}`                 | `tickets.dispatch` | —                                              | `404 MAINTENANCE_CASE_NOT_FOUND`                                                             |
| `POST /maintenance/cases/{id}/resolve`        | `tickets.dispatch` | `{ reasonCode }` from `maintenanceCaseResolve` | `409 MAINTENANCE_CASE_CLOSED` (`params.status`)                                              |
| `POST /maintenance/cases/{id}/dismiss`        | `tickets.dispatch` | `{ reasonCode }` from `maintenanceCaseDismiss` | `409 MAINTENANCE_CASE_CLOSED`                                                                |
| `POST /maintenance/work-orders` with `caseId` | `tickets.dispatch` | ADR 0076's body                                | `409 MAINTENANCE_CASE_CLOSED`, `409 MAINTENANCE_CASE_HAS_WORK_ORDER` (`params.ticketNumber`) |

A case: `{ id, categoryId, categoryKey, buildingId, buildingName, status, openedAt, automatic, ticketCount, workOrder: { id, number, status } | null, closedAt, reasonCode }`; its page adds `tickets: [{ id, number, status, unitCode, createdAt, linkedAt }]`. Notices: `maintenance_case.opened` (the dispatch; target `maintenance_case`), `ticket.case_linked` and `ticket.case_resolved` (the reporter; target `ticket`).
