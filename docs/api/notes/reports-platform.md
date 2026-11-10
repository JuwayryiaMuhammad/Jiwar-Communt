# The reports platform (ADR 0086)

## Reports

- `GET /staff/reports` — the reports the caller may read: `key`, `title` (en, ar), `permission`, `groupBy` (the default first). For a holder of any of `assets.manage`, `stock.manage`, `tickets.dispatch`, `energy.read`, `finance.reports`.
- `GET /staff/reports/view?report=…&from&to&groupBy&compare` — `report` one of `maintenance_spend`, `stock_consumption`, `service_by_building`, `energy_cost`, `collections_by_building`. `from`/`to` the compound's days (30 to today by default, at most 366: `PERIOD_TOO_LONG`). `groupBy` one of the report's (`INVALID_VALUE {allowed}`). `compare`: `none` (default), `previous`, `last_year`, `both`.
  - Answer: `columns` (`key`, `en`, `ar`, `kind` text|number|money, `sum`), `dimensions` (the leading columns that name a row), `rows[]` (`values`, `previous`, `lastYear`: cells as decimal strings or null), `totals`, `period`, `previousPeriod`, `lastYearPeriod`.
  - A row only an earlier period had is listed too; a summed figure it lacks is `0`, any other null.
  - Another report's permission: `403 REPORT_NOT_YOURS {permission}`. More than 5000 rows: `422 REPORT_TOO_LARGE {max}`.
- `GET /staff/reports/export?…&format=pdf|xlsx|csv` — the same as a file, no-store; each figure with the earlier value and the change in percent. Audited `report.exported` (key, format, period, grouping, comparison, rows).
- `energy_cost`: per building and kind (electricity, water, gas): use, unit, cost, the floor area of all its units, the units with no area, cost per m², and `note` — `no_tariff` (no tariff in force: no cost) or `no_area` (a unit has no recorded area) instead of a number.
- `collections_by_building`: a building with fewer than three invoiced units is in the row with a null building.
- Ticket counts and costs: ADR 0081's sensitive tickets are left out for a reader without `tickets.sensitive` and in every scheduled run (at the rebase).

## Schedules and runs

- `GET|POST /staff/report-schedules`, `PATCH /staff/report-schedules/{id}` (`reports.schedule`; the caller must read the report): `reportKey`, `cadence` (daily: the day before; weekly: Saturday to Friday; monthly: the month before), `format`, `compare`, `groupBy`; `active` pauses. At most 50 (`409 REPORT_SCHEDULES_FULL {max}`).
- A run is written once per schedule and period, within 15 minutes of the period's end, never for a period that ended before the schedule was made. Its readers get `report_run.ready` (`reportKey`, `periodFrom`, `periodTo`): no figure, no link.
- `GET /staff/report-runs?scheduleId&cursor&limit` — runs of the reports the caller may read. `GET /staff/report-runs/{id}/download` — `{url, expiresAt}`, no-store, for a holder of the report's permission now (`404 REPORT_RUN_NOT_FOUND` otherwise). A run's file is kept 90 days (`status: expired` after).

## Capital plans

- `GET|POST /maintenance/capital-plans` (`assets.manage`): `{ year, seed? }` — this year or the next five (`INVALID_NUMBER {min, max}`), one a year (`409 DUPLICATE_RESOURCE` on `year`); `seed` adds the register's replacements due that year (an overdue one this year) as `computed` lines.
- `GET /maintenance/capital-plans/{id}`; `POST …/{id}/lines { assetId?, description, amount }` (an asset once: `DUPLICATE_RESOURCE` on `assetId`); `DELETE …/{id}/lines/{lineId}`. Only a draft: `409 CAPITAL_PLAN_NOT_DRAFT {status}`.
- To the board: `POST /staff/governance/approvals { type: 'capital_plan', capitalPlanId, context, impact }` — no `cost` (`FIELD_NOT_ALLOWED`: the total is), not empty (`409 CAPITAL_PLAN_EMPTY`). `status`: `draft` → `submitted` → `approved` (locked for good); rejected or withdrawn, `draft` again.

## The compound's export

- `POST /staff/compound-exports` (`compound.export`, never a deputy's): a fresh step-up first (`403 STEP_UP_REQUIRED`); one at a time (`409 COMPOUND_EXPORT_ACTIVE`), one a day (`429 COMPOUND_EXPORT_RATE_LIMITED {retryAfter}`), five tries an hour (`429 RATE_LIMITED`).
- `GET /staff/compound-exports` — the latest ten: `status` pending|building|ready|expired|failed, `tables`, `rows`. `GET …/{id}/download` — `{url, expiresAt}`, no-store, while ready (7 days). `compound_export.ready` tells who asked, with no link.
- The archive: `README.json` (each file's columns) and one CSV per table of `EXPORT_TABLES` (`src/core/reports/export-tables.ts`). No person's data: no name, phone, email, ID, account id, free text, occupancy, unit dues, household meter or a ticket's unit.

## Taxes (ADR 0093)

- `tax_vat` (`groupBy=month|source`) and `tax_withholding` (`groupBy=vendor|category|month`), to holders of `finance.ledger`; the same views, exports, comparisons and schedules. See [taxes.md](taxes.md).
