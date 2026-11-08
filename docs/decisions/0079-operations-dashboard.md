# 0079 — The operations dashboard: the cards in one call, what needs the manager now, every building's status, the daily brief and end-of-day review, service pressure, and the gate's traffic and log search pages

**Status:** Accepted · M2-4 · amends ADR 0010 (a permission), 0056 (the gate log's export; its pages), 0073 (the inbox read by the dashboard and the brief)

## Context

The manager audit of 2026-11-01 (operations rows MO-2: "موجز تشغيلي يومي", "مراجعة نهاية اليوم", "قائمة ما يحتاج تدخله الآن", "مؤشرات لحظية", "التنبيهات الحرجة", "تنبيهات ضغط الخدمات", "عرض حالة كل مبنى ومنطقة"; security group D's dashboard pages) found that the overview built its numbers from first pages of 100 rows, three queues merged in the browser ("No count endpoints"). There was no staff brief, no end-of-day review, no service-pressure rule, no status per building, and the gate's traffic report and log search had no page. The owner approved the plan and every recommendation of the audits (2026-11-01), the end-of-day review at a compound setting, 17:00 by default, and liquidity days left empty until cash flow exists among them. M2-1 (the buildings, ADR 0072), M2-3 (the inbox, ADR 0073) and M2-2 (the SLA's at-risk level, ADR 0076) are what it builds on.

## Decisions

### A registry of sections, as the inbox's

- **`StaffDashboard` in core** (`src/core/staff-dashboard/`). Core imports no domain (ADR 0015): each domain registers its section at startup and reads it in the caller's tenant transaction (RLS), in a fixed number of aggregate queries whatever the compound's size.
- **Six sections**, each shown to the holders of its own domain's permission and null to the others:

  | section | domain | permission | figures |
  |---|---|---|---|
  | `units` | community | `units.read` or `units.directory` | units, occupied, vacant, closed (ADR 0072's states) |
  | `maintenance` | maintenance | `tickets.dispatch` | open (new or in a technician's hands), unassigned, on hold, awaiting the residents, emergencies open and unassigned, at risk and past the SLA (the list's `overdue`, ADR 0034), opened, completed and closed today, plan occurrences and inspections due today, service pressure |
  | `energy` | maintenance | `energy.read` | outages in force and later today, meter spikes not acknowledged (ADR 0066) |
  | `security` | gate | `incidents.manage` | incidents today, open, open and critical; live lockdowns |
  | `gate` | gate | `gate.read` | entries and exits today, visitors let in (the traffic report's three ways) |
  | `finance` | finance | `finance.reports` | collected today and this month net of reversals (the collections report's), what the invoices due this month so far ask after credit notes and the share paid, what is owed past its due day |

- **Counts, shares and amounts of the compound only:** never a person, a unit, a plate or anyone's words. "Today" is the compound's local day in its time zone, by the database's clock (`dayOf`: its first instant, a daylight-saving change that skips midnight included).
- **One reader of the buildings** (community's): the register's id and name. A section may count per building: the units (and the occupied ones), the open, overdue and emergency tickets (a unit's building, or the building a common area names, as ADR 0076's filter), the outages in force (a compound-wide one cuts every building).
- A missing section stops the app at bootstrap, as a missing inbox type does.

### The routes (`dashboard.read`)

- **`dashboard.read`** (staff, manager): the manager, the two supervisors and the accountant by default. It opens the page; each section still needs its own permission. Holding it lets a staff account into the manager dashboard.
- **`GET /staff/dashboard`**: every section the caller reads, the inbox's badge (its own count, ADR 0073, for an `inbox.read` holder) and `liquidityDays: null` (there is no cash flow yet).
- **`GET /staff/dashboard/needs-you`**: the alerts, then the inbox's items. The alerts are rules over the figures the caller reads, never stored: critical — an emergency past the SLA, an emergency nobody holds, a live lockdown, an open critical incident; warnings — other tickets past the SLA, service pressure, an outage in force, an unacknowledged meter spike. The items are the inbox's own list (ADR 0073, no queue of its own): its overdue items first, then its oldest, ten at most, with the inbox's count.
- **`GET /staff/dashboard/buildings`**: every building of the register, with the sections the caller reads and a band — `critical` with an outage in force or an emergency open in it, `attention` with a ticket past the SLA, `ok` otherwise.

### The daily brief and the end-of-day review

- **Times, a compound setting:** `staff_dashboard_settings` (minutes after local midnight; 07:00 and 17:00 by default; null: not written; the review after the brief, a CHECK and `ENDS_BEFORE_START`). `GET /staff/dashboard/settings` for the dashboard's readers; `PATCH` for `settings.manage`, under an advisory lock (the row may not exist yet), audited as `staff_dashboard.settings_changed` (the times from and to).
- **Written once per compound, kind and local day.** The sweep `staff_dashboard.briefs` runs every five minutes. Once the compound's clock has passed a kind's time, it writes the kind's `staff_briefs` row as the system: every section's figures as of then and the inbox's count of every type. The key (tenant, day, kind) with `ON CONFLICT DO NOTHING` is the "once". Two sweeps at once both read and one writes; the other writes nothing and tells nobody. The writer tells every holder of `dashboard.read` (`staff_brief.ready` or `staff_review.ready`, the day only).
- **Not written** in a suspended compound, nor a day late: past midnight, the day before is not written. A time moved after a kind was written applies from the next day.
- **The two kinds are the same figures at two moments.** In the morning they show today's plan: planned work and inspections due, what is open and waiting. At the end of the day they show what the day did: opened, completed, closed, and what is carried over.
- **Kept, never changed** (a trigger, like the board's reports). `GET /staff/briefs` (newest first, `?kind=`) and `GET /staff/briefs/{id}` read one back with the sections the reader may read now. The inbox's count is filtered to the reader's types, with its totals counted again. Another compound's brief is `404 STAFF_BRIEF_NOT_FOUND`.

### Service pressure

- **The rule:** the open tickets (new, or in a technician's hands) against the technicians who take work now (active, holding `tickets.work`, `available`, ADR 0033). A compound sets how many open tickets one available technician may carry: `maintenance_service_pressure.open_per_technician`, 1–100, null for no alert, the default. Set with `PATCH /maintenance/service-pressure` (`maintenance.manage`); audited as `maintenance.service_pressure_changed`. `GET` (`tickets.dispatch`) shows the state.
- **Under pressure** at `open ≥ threshold × max(available, 1)`.
- **Debounced, no alert storm.** The sweep `maintenance.service_pressure` runs every five minutes. It keeps the rise on the compound's row under the row's lock, `raised_at` and `told_at`:
  - a rise is told to the dispatch and the managers once (`maintenance.service_pressure`: open, available, the threshold);
  - it eases silently when the open tickets fall below the line;
  - a new rise within an hour of the last notice is told when the hour is up, if it lasts.
  - So there is one notice an hour at most, however the count wavers. Two sweeps at once meet on the row; the second finds the rise told. A change of the threshold takes the same lock; turned off, a rise in course ends.

### The gate's pages

- **The traffic report** (ADR 0056, `gate.read`) and **the log search** (ADR 0056, `gate_log.search`) gain their dashboard pages; their routes and rules are unchanged.
- **`POST /staff/gate/log-search/export`**: the search's body to a CSV, every entry it finds, newest first, at most 50 000 (`EXPORT_TOO_LARGE`), no-store and not kept. It follows the search's rules: 31 of the compound's days, a visitor named exactly by the name's key (never a part of it), no idempotency record, and the search's rate (20 a 10 minutes, shared). Being personal, every export is audited (`gate.log_exported`: the days, the unit, whether by name, the rows), never the name. The dashboard posts it, so a name never sits in a URL.

## Deviations for the owner

1. **Service pressure is off by default.** The audit named no number. On by default, it would tell compounds that never chose one; a manager sets it in Maintenance setup → Dispatch.
2. **Service pressure is maintenance's.** It compares open tickets against available technicians. Guards' posts and the office are not measured: the guards' roster has its own unmanned-post notice (ADR 0050), and nothing else has a capacity to measure yet.
3. **The end-of-day review has no "decisions made today".** No common record of decisions exists across the domains, only their audit entries. The review shows instead what was opened, completed and closed, and what still waits (the inbox).
4. **The brief is on by default, at 07:00**, beside the review's 17:00 (the audit's). Both are told in the app to every `dashboard.read` holder, and nobody is emailed beyond the notification's own delivery preferences.
5. **"Critical alerts unhandled" is not a card of its own.** The bell already counts unread critical notifications (`GET /me/notifications`); the dashboard's alerts are rules over the figures. A `priority` filter on the notifications list is not built.
6. **Per building:** units, tickets and outages only. An incident has a place, not a building, and a lockdown is a gate's or the compound's, so security shows on the compound's card. A unit with no building, and a common area that names none, count on the compound's cards and on no building.
7. **The gate log export keeps ADR 0056's rule:** names are never listed, as the audit recommended. A name finds entries only when typed exactly.
8. **No stored layout and no wall mode.** The customizable dashboard and the operations-room screen are front end over these routes; no per-account layout is stored.
9. **A day missed is not written late.** If the app is down past midnight, that day's brief and review are not written.

## Consequences

- New tables `staff_dashboard_settings`, `staff_briefs` and `maintenance_service_pressure`, each under RLS; migrations 20270316090000 (the dashboard) and 090100 (service pressure). No existing table changes.
- New permission `dashboard.read`; notices `staff_brief.ready`, `staff_review.ready`, `maintenance.service_pressure`; audit entries `staff_dashboard.settings_changed`, `maintenance.service_pressure_changed`, `gate.log_exported`; error `STAFF_BRIEF_NOT_FOUND`.
- The inbox gains `countAll` (every type, for the brief) and is exported to the dashboard; the SLA's at-risk share is shared with its count.
- The manager dashboard's overview reads the summary instead of paging three queues; "Daily briefs", "Gate traffic" and "Gate log search" are new pages, and service pressure sits in Maintenance setup → Dispatch.
- No request pays for any of it: the figures are read on the dashboard's own routes only.
- Every ticket count of the dashboard goes through one condition (`countable`). When sensitive tickets come (M2-13, ADR 0081), their filter takes its place: a reader without `tickets.sensitive` counts none of them, and neither does the brief, which the sweep writes for every reader. Service pressure alone counts every open ticket: it is the team's load, and it names no ticket.

## Open

- Liquidity days (with cash flow, M3).
- A per-account layout and a wall mode.
- Service pressure beyond maintenance, and a pressure rule per category or building.
- A brief by email or as a PDF; a weekly summary.
- The review's "decisions made today", once the domains keep one record of decisions.

## Update (Phase M3-4, ADR 0091)
- `liquidityDays` is filled: the live bank and cash accounts' balances over the average daily spending of the 90 days before today (live expenses by their day), whole days, 0 at no cash. It is a number to a `finance.cashflow` holder and stays **null** without the permission, with no account or with nothing spent in the window (never infinite). Finance registers it with `StaffDashboard.registerLiquidity`, as a section; a missing reader stops the start.
- "Needs you now" gains `cash_below_minimum` (critical: the cash on hand is below the compound's minimum) and `cash_forecast_below_minimum` (warning: a week of the 13-week forecast closes below it), section `finance`, to `finance.cashflow` holders.
- The Open item "Liquidity days (with cash flow, M3)" is done. The brief does not store them (liquidity is not a section): ADR 0091 Open.

## Update (M2-12b, ADR 0090)
- **A rise of service pressure, when told, suggests reinforcement** to the field team, in the same transaction under the pressure row's lock: one open suggestion per compound, an inbox item for `field_team.manage`; it lapses when the pressure eases or is turned off. The notice to the dispatch and the managers, and its debounce, are unchanged.
