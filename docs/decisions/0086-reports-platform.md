# 0086 — The reports platform: curated reports by permission, compared and drawn as PDF, workbook or CSV, sent on a schedule once per period, the capital plan to the board once a year, energy cost per m², and the compound's export

**Status:** Accepted · M3-3 · amends ADR 0010 (two permissions), 0029 (two server-only file purposes, a workbook type), 0055 (the approval type `capital_plan`), 0062 (a report's table as a PDF), 0065 (the computed capital plan seeds a stored one), 0066 (cost per m² on the consumption groups), 0073 (the export is never a deputy's)

## Context

The manager audit of 2026-11-01 (finance slice 05: "تقارير مقارنة بين الفترات", "تصدير PDF و Excel", "جدولة إرسال التقارير", "تصدير كامل البيانات"; assets slice 02 group B: spend by building and asset type, stock consumption, the capital plan to the board, energy cost per m²) found: every report took one period and answered JSON or CSV; no report compared periods; there were no report PDFs and no workbooks; nothing was sent on a schedule; maintenance spend had no building or asset-type view; stock had raw movements only; the capital plan was computed and could not go to the board; energy groups had no cost per m²; and there was no compound-wide export. The owner approved the plan (row M3-3) and every recommendation of the audits: one `capital_plan` approval per year listing its lines (02, decision 10); the full export by the manager with a step-up, operational data only (gap audit, decision 12).

## Decisions

### A registry of curated reports, in core

- **`StaffReports`** (`src/core/reports/report-registry.ts`), the dashboard's pattern (ADR 0079 `StaffDashboard`; the inbox's, ADR 0073): core imports no domain; each domain registers its reports at startup with a key of the closed list `REPORT_KEYS`, **its own permission**, its groupings (the first the default), its columns per grouping (the leading ones name a row) and a reader that runs in the caller's tenant transaction (RLS) and aggregates in SQL. A report missing at bootstrap, or read by a permission outside `REPORT_READERS`, fails the boot.
- **The reports** (groups of the compound only — a building, an asset type, an item, a category, a month; never a person, a unit or anybody's words):
  - `maintenance_spend` (`assets.manage`, as economics): cost entries of the period's days (voided ones aside) by building (the ticket's unit's, its area's, or its asset's place's), asset type, category or month — tickets, labour, contractors, parts, other, total, and its share of the total.
  - `stock_consumption` (`stock.manage`): issues and returns of the period (ADR 0065) by item (issued, returned, used, value at the average cost then, used a month) or by asset type or month (counts and value only: quantities of different items do not add up).
  - `service_by_building` (`tickets.dispatch`): per building, its units, the tickets opened and completed on the period's days (cancelled ones aside), the emergencies, the mean hours to complete, opened per 10 units, and its share of the tickets beside its share of the units (fair service between buildings).
  - `energy_cost` (`energy.read`): below.
  - `collections_by_building` (`finance.reports`): per building, the invoices due on the period's days after credit notes, what is paid of them, what is owed, and the share collected, from ADR 0046's fragments. **A building with fewer than three invoiced units is folded into one row with the other small ones** (null building): no row is one household's dues.
- **Ticket reads and sensitive tickets.** Every ticket the reports count or cost goes through one condition (`countable()` in `src/maintenance/reports/maintenance-reports.ts`): ADR 0081's `SensitiveTickets` filter, so a reader without `tickets.sensitive` counts none of them, nor does a scheduled run (the system reads it for every holder), as ADR 0079 did for the dashboard. The compound's export never holds a sensitive ticket, whoever exports (`NOT sensitive` on its tickets table); their cost entries stay, as ADR 0081 keeps side records.
- **Reads.** `GET /staff/reports` (the catalog the caller may read), `GET /staff/reports/view?report&from&to&groupBy&compare`, `GET /staff/reports/export?…&format=pdf|xlsx|csv` (no-store; audited `report.exported` with the key, format, period, grouping, comparison and row count — never a figure). A report is named in the query, never the path: every path parameter of the API is an id. Another report's permission answers `403 REPORT_NOT_YOURS {permission}`; a grouping it does not offer `INVALID_VALUE {allowed}`; a period is the compound's days, at most 366 (`PERIOD_TOO_LONG`), the 30 days to today by default; more than 5000 rows `422 REPORT_TOO_LARGE {max}`.

### Comparisons

- `compare`: `previous` (as many days just before), `last_year` (the same days a year earlier; 29 February is the 28th), `both`, `none`. The rows of the periods line up on their dimensions, in the current period's order, then the rows only an earlier period had. A summed figure (a count, an amount) a period has no row for is 0 there; any other (a share, a rate, a cost per m²) is null. The totals row adds the summed columns.
- On screen each row carries `values`, `previous` and `lastYear`; a file flattens each figure into the value, the earlier value and the change in percent (to one decimal; none from a base of 0).

### The files

- **PDF**: `src/core/pdf/report-table.ts` on ADR 0062's renderer (fonts, bidi): the compound, the title in English and Arabic, the period and what it is compared with, then the table with its header on every page and the totals in bold; A4 portrait up to six columns, landscape beyond (`PdfRenderer.render` gains a layout), the type shrinking with the columns. Same result and instant, same bytes.
- **Workbook**: `src/core/reports/xlsx.ts`, the smallest SpreadsheetML (one sheet, a bold header, inline strings, numbers as numbers) zipped with **fflate, already the exports' dependency (ADR 0036): no new dependency**. A text cell that starts with `=` stays text (a formula is an element of its own, never written). Same input, same bytes.
- **CSV**: ADR 0048's `toCsv`.

### Scheduled sending, once per period

- **`report_schedules`** (`reports.schedule`, the manager's; the scheduler must hold the report's own permission too): a report, a cadence — daily (the day before), weekly (**Saturday to Friday**, the compound's week, its weekend Friday), monthly (the month before) — a format, a comparison and a grouping; paused and resumed (`PATCH`), never deleted (its runs name it); at most 50 per compound (`409 REPORT_SCHEDULES_FULL`, counted under the compound's advisory lock). Its report, cadence and author never change (a trigger).
- **The sweep** `reports.schedules` (every 15 minutes) writes each active schedule's last whole period, never an older one and never one that ended before the compound's day the schedule was made; not in a suspended compound. Each run in a transaction of its own:
  1. **the period's advisory lock** (schedule and period), then the run looked for again — two sweeps at once wait for each other and the second finds the first's run and writes nothing; the unique key `report_runs_once_per_period` (tenant, schedule, period's first day) backs it;
  2. the report read and drawn as the system, its file uploaded to the private bucket and attached as a **`report_file`** (`ownerAccountId` null, ready and attached at once), the run written (`report_run.written`);
  3. the staff who hold the report's permission then (`StaffRecipients`, deputies included) told with **`report_run.ready`**: the report's key and the period only, **never a figure and never a link**.
  A failure rolls the transaction back and deletes the object it uploaded; the next sweep tries again while the period is the last one.
- **Delivery through the files service**: `GET /staff/report-runs` (the runs of the reports the caller may read) and `GET /staff/report-runs/{id}/download` — a presigned GET in a no-store response, to a holder of the report's permission **now** (a run of a report the caller may not read is not found to them); audited `report_run.downloaded`.
- **Retention**: a run keeps its file 90 days; the sweep `reports.runs_expire` then expires it (`report_run.expired`) and the files sweep deletes the object. A run is written once and expires once (a trigger).

### Energy cost per m²

- `energy_cost`: for electricity, water and gas, each building's use and cost (ADR 0066: the readings spread over their days, at the tariffs in force), over **the floor area of all the building's units** (ADR 0072). No number where it would mislead: without a tariff in force the cost is unknown (`note: no_tariff`); with any unit of the building whose area is not recorded the area is unknown (`note: no_area`, with how many units have none); the cost per m² is null in both cases.
- The consumption API's groups (`GET /maintenance/energy/consumption`) gain `areaSqm` (their metered units' area), `costPerSqm` and `costPerSqmMissing` (`no_tariff` | `no_area`) the same way.

### The capital plan to the board

- **`capital_plans`**, one a year per compound (`capital_plans_year_key`; a second is `409 DUPLICATE_RESOURCE` on `year`), for this year or the next five by the compound's day, with `assets.manage`. `seed: true` starts it from the register's computed plan (ADR 0065: each asset in service with a replacement cost, in its commissioning year plus its life; an overdue one falls in this year) as `computed` lines.
- **Lines** (`capital_plan_lines`), while a draft, under the plan's row lock: an asset of the register (once per plan, `DUPLICATE_RESOURCE` on `assetId`) or the staff's words alone, and an amount (`LARGE_AMOUNT`). Never edited, removed only from a draft; a trigger refuses any line of a plan that is not a draft. A line's words are plain data, shown to the board with the package, never in the audit trail or a notice.
- **The board** (ADR 0055): a new approval type **`capital_plan`** naming the plan (`capitalPlanId`; its cost is the total, `cost` not allowed), 30 days by default (backfilled). At the raise, under governance's locks and then the plan's, a draft with lines (`409 CAPITAL_PLAN_EMPTY`) is submitted (`capital_plan.submitted`); anything else is `409 CAPITAL_PLAN_NOT_DRAFT {status}`. Approved by the board's motion it is **locked for good** (`capital_plan.decided`; a trigger refuses any change of an approved plan, and its lines' trigger any line); rejected or withdrawn, the draft comes back (`capital_plan.returned`).
- **One approval a year** is structural: one plan a year, two raises meet at the plan's row lock (the second finds it submitted), governance's one pending request per subject, and the lock once approved.

### The compound's export

- `POST /staff/compound-exports` (`compound.export`, the manager's, **never a deputy's**): at most five tries an hour per account (the rate limit), then under the compound's advisory lock one being prepared at a time (`409 COMPOUND_EXPORT_ACTIVE`; a partial unique index backs it) and one a day (`429 COMPOUND_EXPORT_RATE_LIMITED {retryAfter}`), then the session's fresh step-up is spent (`403 STEP_UP_REQUIRED` without one).
- **Fixed tables and columns** (`src/core/reports/export-tables.ts`, pinned by a unit test with a guard on any column named for a person or someone's words): buildings, units (code, building, floor, type, area), common areas, asset types, assets, ticket categories, tickets (**never their unit**: what a household asked for), cost entries, plans and occurrences, stores, stock items, levels and movements, **the common meters and their readings only** (a household's meter is its own, ADR 0069), tariffs, budgets and lines, expenses (never the vendor's name or the invoice), capital plans and lines (never a line's words). No name, phone, email, ID, photo, account id or free text. A person's data leaves only through ADR 0036's export.
- **Build** (sweep `compound_exports.build`, every minute; ADR 0036's pattern): leased under SKIP LOCKED, streamed table by table, a page of 2000 rows by id at a time each in its own tenant transaction, as CSV deflated into a zip of at most 512 MB (`compound_export`) uploaded in parts; then the file attached, the export ready for 7 days and who asked told in the app (`compound_export.ready`, no link). Three failed builds, or one too large, fail it.
- `GET /staff/compound-exports` (the latest ten) and `…/{id}/download` (a presigned GET, no-store, for a holder of `compound.export`). Audited at every step with ids and counts only: requested, ready, downloaded, failed, expired.

### Nothing for the staff inbox

- A capital plan waits for the board, whose approvals are governance's queue, not the staff inbox (ADR 0073); a run and an export are notices.

### Personal data

- A schedule names the manager who made it, an export who asked: ids of the compound's records, kept as other authorship is (ADR 0023 anonymizes the account, never these rows); not part of the per-account export. No table of this phase holds a person's data.

## Deviations for the owner

1. **XLSX without a library**: a small writer on fflate (already a dependency) instead of `exceljs`; no install, no new supply chain. `exceljs` stays the way to richer workbooks (styles, several sheets, charts) if they are wanted.
2. **The week runs Saturday to Friday** (the compound's working week), not ISO's Monday to Sunday.
3. **A run's file is a stored file kept 90 days**, then deleted; the board's monthly report (ADR 0075) stays its own (drawn on demand).
4. **Collections fold buildings of fewer than three invoiced units** into one row (the audits' "aggregates of three or more", 05 decision 9, applied to money).
5. **Energy cost per m² needs every unit of the building to have an area**: one unit without leaves the number out (`no_area`), rather than dividing by part of the building.
6. **The compound export leaves out a ticket's unit**, a household's meter and its readings, a vendor's name and a line's words; the units' register itself (code, building, floor, type, area) is in it.
7. **The compound export is never a deputy's** (ADR 0073's list gains it).
8. **No custom report builder** (the gap audit's "منشئ تقارير مخصص"): five curated reports with groupings; a builder over them waits for the owner.
9. **The capital plan's report is its page and the board's package**, not a registry report.
10. **Energy's figures are computed in code from SQL-read periods** (ADR 0066's spread of readings over days); the other reports aggregate in SQL.

## Consequences

- New tables `report_schedules`, `report_runs`, `capital_plans`, `capital_plan_lines`, `compound_exports`; two file purposes and the workbook type; the files CHECKs recreated whole; the approval type and subject CHECKs and the settings backfill.
- Migrations 20270611090000 (the purposes), 090100 (schedules and runs), 090200 (the capital plans and the approval type), 090300 (the compound's export) and 090400 (every CHECK the phase widens, with every value before it, and the settings backfill), dated after ADR 0085's so the stack applies in order.
- Permissions `reports.schedule`, `compound.export` (the manager's; the permission sync brings them).
- The manager dashboard: Reports, Scheduled reports, Sent reports, Capital plans (and its submission through the raise dialog), Compound export.

## Open

- A custom report builder over the curated reports; more reports (the SLA's, the facilities', safety's) registered as their domains choose.
- Report recipients beyond the permission's holders (the board, by email with a link).
- A capital plan's lines tied to the budget's lines once approved (M3-1).
- The compound export's audit-log table (ADR 0014 Open) and a GL-format export (M3-5).

## Update (Phase M3-4, ADR 0091)
- A sixth report, `cash_flow` (`finance.cashflow`, now among `REPORT_READERS`): the money into and out of the compound's bank and cash accounts on the period's days, by month, movement kind or account, openings and transfers between the accounts left out.

## Update (Phase M3-5, ADR 0092)
- Four reports of the general ledger (`finance.ledger`, now among `REPORT_READERS`): `gl_trial_balance`, `gl_income_statement`, `gl_balance_sheet` and `gl_general_ledger`. The GL-format export is the journal's CSV (`GET /staff/finance/gl/journal/export`).

## Update (Phase M3-6, ADR 0093)
- Two reports for `finance.ledger`: `tax_vat` (the declaration's figures by month or by source) and `tax_withholding` (the certificates by vendor, category or month), PDF, workbook and CSV, compared and scheduled.

## Update (Phase M3-7, ADR 0094)
- Three reports for `finance.payables` (now among the reports' readers): `po_open`, `po_received_not_invoiced`, `po_match_exceptions`.
