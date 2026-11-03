# Compliance and safety (ADR 0087)

For the manager dashboard and the staff apps. Every route is under `/api/v1`.

## The compliance calendar (`compliance.manage`)

| Route                                                              | What                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /staff/compliance/items?kind&status&ownerId&vendorId&assetId` | Items in the order made, each with its open due day (`current`), its last done one, and its `state` today: `valid`, `due_soon`, `overdue`, `completed`, `retired`.                                                                        |
| `POST /staff/compliance/items`                                     | `{kind, title, authority?, reference?, assetId? \| commonAreaId?, vendorId? and/or ownerId?, recurrenceMonths?, leadDays?, notes?, firstDueOn}`. `Idempotency-Key` honoured. The first due day is made with it; the staff member is told. |
| `GET /staff/compliance/items/{id}`                                 | With `occurrences`: the due days, latest first (100), each with its `evidence` (short-lived `fileUrl`).                                                                                                                                   |
| `PATCH /staff/compliance/items/{id}`                               | Any field; null clears an optional one; `leadDays: []` uses the compound's; `nextDueOn` moves the open day (from today). Retired: `COMPLIANCE_ITEM_RETIRED`.                                                                              |
| `POST /staff/compliance/items/{id}/retire`                         | `{reasonCode}` from `complianceRetire`; its open day is called off.                                                                                                                                                                       |
| `POST /staff/compliance/occurrences/{occurrenceId}/complete`       | `{doneOn, certificateNumber?, expiresOn?, note?, nextDueOn?, fileIds?}`. Once: then `COMPLIANCE_OCCURRENCE_ENDED {status}`. Answers the item, with its next due day: `nextDueOn`, else `expiresOn`, else the recurrence, else none.       |
| `POST /staff/compliance/occurrences/{occurrenceId}/evidence`       | `{fileId}`: a finalized `compliance_evidence` upload (an image or a PDF, 10 MB); 20 live a due day.                                                                                                                                       |
| `DELETE /staff/compliance/evidence/{evidenceId}`                   | Removed once.                                                                                                                                                                                                                             |
| `GET /staff/compliance/calendar?from&to`                           | Due days and the vendors' papers expiring, by day (`source`: `compliance` \| `vendor_document`); 90 days by default, 366 at most (`PERIOD_TOO_LONG`).                                                                                     |
| `GET /staff/compliance/report` · `/report/export`                  | Counts per kind and the vendors' papers; the CSV is one row per item. `no-store`.                                                                                                                                                         |
| `GET` · `PUT /staff/compliance/settings`                           | `{leadDays}`: one to three, 1–365 days each, longest first; 60, 30, 7 by default.                                                                                                                                                         |

Notices: `compliance_item.assigned`, `compliance.due_soon` (`complianceKind`, `dueOn`, `daysLeft`) once per lead time, `compliance.overdue` once; target `compliance_item`.

## Corrective actions

| Route                                                                          | Who                                  | What                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /staff/security/incidents/{id}/actions`                                   | `incidents.manage`                   | In the order made, with `overdue`.                                                                |
| `POST /staff/security/incidents/{id}/actions`                                  | `incidents.manage`                   | `{description, ownerId, dueOn}` (from today, a year ahead). A closed incident: `INCIDENT_CLOSED`. |
| `PATCH /staff/security/incident-actions/{actionId}`                            | `incidents.manage`                   | While open; ended: `INCIDENT_ACTION_ENDED {state}`.                                               |
| `POST /staff/security/incident-actions/{actionId}/done` · `/cancel`            | `incidents.manage`                   | `{note?}` · `{reasonCode}` from `incidentActionCancel`.                                           |
| `GET /staff/incident-actions` · `POST /staff/incident-actions/{actionId}/done` | the owner (any staff, no permission) | Their own open actions; another's is not found.                                                   |

`POST /staff/security/incidents/{id}/close` answers `409 INCIDENT_ACTIONS_OPEN {open}` while one is open. The incident views carry `actions {open, done, cancelled}`. Notices `incident_action.assigned` and `.overdue` (`dueOn`) target the incident.

## Safety KPIs

`GET /staff/security/reports/safety?from&to` (`incidents.manage` or `guard_reports.read`, `no-store`): 30 days by default, 366 at most. `incidents` (with `lastInjuryOn`, `daysWithoutInjury`), `observations` (hazards and near misses: `closureRatePct`, `avgHoursToClose`), `actions` (`onTimeRatePct`, `openNow`, `overdueNow`), `drills`. The incidents report now takes 366 days too.

## Drills

A readiness item `kind: drill` takes `drillType`; its done takes `outcome` (`drillOutcome`) and `participants` (0–10000), `minutes` (1–600) optional. The item view carries `drillType`, `drillOutcome`, `drillParticipants`, `drillMinutes`.

## A lockdown from the office

`POST /staff/security/lockdowns` (`lockdown.start`, the manager): the guard's body, `{scope, gateId?, reasonCode, confirmation: "LOCKDOWN"}`; `201` new, `200` with the live one. The lockdown views carry `startedFrom` (`gate` | `office`).
