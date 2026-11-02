# The operations dashboard: backend notes for the dashboards

What was built for the manager's operations dashboard (ADR 0079):
- the cards in one call;
- what needs the manager now;
- every building's status;
- the daily brief and the end-of-day review, and their times;
- service pressure;
- the gate log's export (the traffic report and the log search are ADR 0056's).

The design decisions are in [ADR 0079](../../decisions/0079-operations-dashboard.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, lists are `{ "data": [...], "nextCursor" }`, errors carry `code` and `fields[].code`. Local days (`YYYY-MM-DD`) and times (`HH:MM`) are the compound's.

## Who reads what

Every dashboard route needs `dashboard.read` (the manager, the two supervisors and the accountant by default). Each section then needs its own permission, and is `null` without it:

| section | permission | in the default roles |
|---|---|---|
| `units` | `units.read` or `units.directory` | manager, security supervisor |
| `maintenance` | `tickets.dispatch` | manager, maintenance supervisor |
| `energy` | `energy.read` | manager, maintenance supervisor |
| `security` | `incidents.manage` | manager, security supervisor |
| `gate` | `gate.read` | manager |
| `finance` | `finance.reports` | manager, accountant |

The inbox's parts need `inbox.read`, and show only the types the reader decides (ADR 0073).

## The cards: `GET /staff/dashboard`

`{ asOf, date, timeZone, figures: { units, maintenance, energy, security, gate, finance }, inbox: { total, overdue } | null, liquidityDays: null }`.

- `maintenance`: `slaEnabled`, `open` (new or in a technician's hands), `unassigned`, `onHold`, `awaitingConfirmation`, `emergencyOpen`, `emergencyUnassigned`, `atRisk`, `overdue` (as the list's `overdue`), `overdueEmergency`, `openedToday`, `completedToday`, `closedToday`, `plannedDueToday`, `inspectionsDueToday`, `pressure: { threshold, available, underPressure, since }`. While the SLA is off, `overdue` and `atRisk` are 0.
- `energy`: `outagesActive`, `outagesLaterToday`, `meterAlertsOpen`.
- `security`: `incidentsToday`, `incidentsOpen`, `criticalOpen`, `lockdownsLive`.
- `gate`: `entriesToday`, `exitsToday`, `visitorsToday`.
- `finance`: `currency`, `collectedToday`, `collectedMonth` (net of reversals), `dueMonth`, `collectionRate` (0–1, null when nothing is due), `overdueInvoices`, `overdueAmount`. Amounts are decimal strings.
- `units`: `units`, `occupied`, `vacant`, `closed`.
- `liquidityDays` is always null until cash flow is built: show a dash.

## Needs you now: `GET /staff/dashboard/needs-you`

`{ asOf, alerts: [{ section, code, severity, count }], items: InboxItemView[] | null, inbox: InboxCountView | null }`.

- The alerts come critical first:
  - critical: `emergency_overdue`, `emergency_unassigned`, `lockdown_live`, `incident_critical_open`;
  - warning: `tickets_overdue`, `service_pressure`, `outage_active`, `meter_alert_open`.
  - Each is computed from the sections the caller reads; none is stored.
- `items` are the inbox's items, overdue first, then the oldest; 10 at most. Open each on its own page, as the inbox does.

## The buildings: `GET /staff/dashboard/buildings`

`{ asOf, buildings: [{ id, name, band, units: { units, occupied } | null, maintenance: { open, overdue, emergencyOpen } | null, energy: { outagesActive } | null }] }`, by name.

- `band` is computed from the sections the caller reads:
  - `critical`: an outage in force over the building, or an emergency open in it;
  - `attention`: a ticket past the SLA;
  - `ok` otherwise.
- A common area's ticket counts on the building its area names.

## The brief and the review

- `GET /staff/dashboard/settings`: `{ briefAt: "07:00" | null, reviewAt: "17:00" | null, timeZone }`.
- `PATCH /staff/dashboard/settings` (`settings.manage`): `briefAt`, `reviewAt` as `HH:MM` (`INVALID_FORMAT`), null turns one off, absent keeps it. The review comes after the brief: `ENDS_BEFORE_START` on the field changed.
- `GET /staff/briefs?kind=brief|review`, newest first: `{ id, kind, date, generatedAt }`.
- `GET /staff/briefs/{id}`: the same, plus `timeZone`, `figures` (as the cards, a section the reader may not read null) and `inbox` (the reader's types, with the totals counted again; null without `inbox.read`). Another compound's: `404 STAFF_BRIEF_NOT_FOUND`.
- Each is written once a day after its time and never changed. The `dashboard.read` holders are told with `staff_brief.ready` or `staff_review.ready` (params `date`; target `staff_brief`, its id): open `/briefs`.

## Service pressure

- `GET /maintenance/service-pressure` (`tickets.dispatch`): `{ threshold, open, available, underPressure, since, toldAt }`.
- `PATCH /maintenance/service-pressure` (`maintenance.manage`): `{ openPerTechnician: 1–100 | null }` (`INVALID_NUMBER` with `params.min`, `params.max`).
- The notice `maintenance.service_pressure` (params `open`, `available`, `threshold`; target `service_pressure`, the compound) goes to the dispatch and the managers: once a rise, at most once an hour.

## The gate log's export

`POST /staff/gate/log-search/export` (`gate_log.search`) takes the search's body: `from`, `to` (31 days at most, `PERIOD_TOO_LONG`), `unitId`, `visitorName` (exact). It answers a CSV, no-store: `occurred_at, gate, direction, subject_type, method, unit, unconfirmed`, newest first. More than 50 000 entries is `422 EXPORT_TOO_LARGE`: narrow the days. It counts against the search's 20 a 10 minutes (`429 RATE_LIMITED`). Fetch it with the BFF header and the body, never a link with the name in it.
