# 0091 — Cash flow and liquidity: a forecast from the bank and cash accounts' balances, what payables already schedules out and the residents' dues in at the collection rate of the last 90 days, by week or month against the compound's minimum cash; the dashboard's liquidity days; the minimum-cash notice; the realised cash flow report

**Status:** Accepted · Phase M3-4 · amends ADR 0010 (a permission), 0077 (two reads of the contracts' schedule), 0079 (`liquidityDays` filled, two alerts), 0085 (the balances read), 0086 (a report and a reader), 0089 (the schedule and the commitments read)

## Context

The manager audit (finance slice 05, 2026-11-01) asked for cash flow and liquidity: "how many days does the cash cover", and "what will the bank hold in the coming weeks". ADR 0079 left `liquidityDays: null` on the dashboard "until cash flow is built"; ADR 0085 (treasury) and ADR 0089 (payables) each said M3-4 reads what they keep: the accounts' balances, the payment schedule and the commitments.

The owner settled the phase (2026-11-08):

1. **The opening position** is the bank and cash accounts' balances (ADR 0085).
2. **Outflows** are what payables already schedules — contract payment schedules, approved vendor invoices by their due dates, commitments not yet invoiced, advances, retentions and guarantees (ADR 0077, 0089) — and anything else already scheduled in the app. **No spending is invented.**
3. **Inflows from residents** are invoices and instalment-plan dues by due date, **multiplied by the actual collection rate of the last 90 days**, defined precisely, with a sensible answer for a compound with no history.
4. **`liquidityDays`** is the days of spending the cash covers; it stays nullable when it cannot be computed.
5. **The billing plans' unissued periods count** (the owner's decision of 2026-11-08, on the phase's question): every period a billing plan will still issue within the horizon, at the plan's amount or the unit's override, excluded units left out, at the same collection rate, on its own line ("projected") beside "invoiced".

Money is `DECIMAL(14,2)` as the repo stores it (ADR 0089, deviation 1).

## Decisions

### Where it lives

- **In finance** (`src/finance/cashflow/`): it reads only finance's own rows, plus maintenance's contract schedule through **core's `PayablesBridge`**, which gains two reads without a lock: `unpaid(through)` (the unpaid payments of the contracts not terminated, due on or before a day) and `terms(ids)` (a contract's retention share, end day and whether it was terminated). Finance still imports no domain (ADR 0046).
- **Computed when asked, never stored.** No table holds a forecast. The compound keeps only its floor and the state of its notice (below).

### The permission

- **`finance.cashflow`** (staff, manager; the manager and the accountant by default; `access:sync` brings it to existing compounds) reads the forecast, its CSV, the realised report, the dashboard's liquidity days and cash alerts, and is told of a dip. It is read-only.
- **The minimum cash is set by `finance.treasury`** (who keeps the accounts). Its read is open to either permission.
- It is `finance.*`, so a deputy never holds it (ADR 0073).

### The horizon and its periods

- `GET /staff/finance/cash-flow?by=week|month&periods=n` (no-store). By **week** by default: the compound's weeks, **Saturday to Friday** (its weekend Friday, as ADR 0086's weeks), **13** by default, at most 26. By **month**: calendar months, 6 by default, at most 12 (`INVALID_NUMBER {min, max}`).
- **The first period starts today** and ends with its week or month, so it may be short. A day before today (something overdue) falls in the first period. A day after the last falls in none.
- `GET /staff/finance/cash-flow/export` is the same forecast as CSV, one row a period (no-store, not audited: it holds the compound's totals only, as the finance reports' CSVs).

### The opening position

- The **live bank and cash accounts' balances** (ADR 0085: the sum of each account's movements), listed one by one, and their total: **the cash on hand**. A retired account holds nothing.
- Money collected but not in an account yet is **not** in the opening. It is an inflow of the first period (below).

### Outflows: what payables already schedules

Each scheduled amount is counted once, on its own day:

| line | what | when |
|---|---|---|
| `vendorInvoices` | approved vendors' invoices (not yet paid), **less the retention** their contract holds back at payout (ADR 0089's `retentionOf`) | their due day |
| `contractPayments` | the unpaid schedule payments of contracts not terminated that **no approved invoice names**, less their retention | their day |
| `purchases` | what the open commitments of approved purchase requests still keep (amount − releases) | the day the purchase is needed by; none: the first period |
| `disbursements` | advances and retention releases **asked for or approved**, not yet paid | the first period |
| `retentions` | per contract: the retention payouts held, less the releases paid and asked for, plus the retention the invoices and payments above will hold back | the contract's end; at once when it ended or was terminated; none after the horizon |

- **Overdue payables** (an approved invoice or a schedule payment past its day) fall in the first period, and their count and amount are shown (`overdue.payables`).
- **Nothing is counted twice.** A payment named by an approved invoice is the invoice's. A contract payment's commitment is the payment's, not a second outflow. A purchase's commitment is released as its invoice is approved (ADR 0089), so the invoice takes over what it gave back. A release asked for leaves the contract's retention.
- **A received invoice not yet approved** counts through what it is against: its schedule payment, or its purchase's commitment. It is never counted itself.

### Inflows: the residents' dues at the collection rate

- **`invoiced`**: issued invoices still owed (total − credit notes − live allocations, ADR 0046's fragments), due in the period. **Instalments are invoices** (ADR 0048), each with its own due day; the invoice an instalment plan took over is credited, so it owes nothing.
- **`projected`** (the owner's decision 5): every period a billing plan will still issue within the horizon (ADR 0069's projection: the periods the billing sweep bills, read ahead). Each unit not billed for the period yet and not excluded counts at its override's amount or the plan's. A period whose nominal due day has passed but which was not issued yet counts today.
- **`dues`** = invoiced + projected; **`expected`** = dues × the collection rate, to the piastre (half up).
- **`inTransit`** (the first period only): money already collected and not in an account yet. That is office cash in custody not handed in (ADR 0085's `OPEN_CUSTODY`), and cheques that paid and have not cleared (received or deposited). It is counted at its face: it is collected.
- **Not counted, shown aside:** dues past their due day (`overdue.receivables`), and dues under an open dispute within the horizon (`disputed`).

### The collection rate, precisely

- **The window** is the 90 days of the compound before today (`today − 90` to `today − 1`; today, still under way, is left out).
- **Due** is what the invoices with their due day in the window asked, after their credit notes: Σ max(total − credited, 0).
- **Collected** is what of those same invoices is paid so far: Σ min(paid, due), where paid counts live allocations net of their releases, and a reversed payment counts nothing (ADR 0046, 0048).
- **The rate** is collected ÷ due, from 0 to 1, rounded to three places. It is the same "what of the dues is paid" as the dashboard's collection rate (ADR 0079) and the collections report (ADR 0086).
- **No history.** With nothing due in the window (a new compound, or one that has not billed for 90 days), the rate is **null** (`basis: no_history`) and the forecast expects **no resident money**. The dues still show at their face (`invoiced`, `projected`, `dues`), so the manager sees what could come. A forecast never counts on money it has no record of collecting.

### Liquidity days

- **`liquidityDays`** = ⌊ cash on hand ÷ (live expenses with their day in the window ÷ 90) ⌋. In words: the live accounts' balances over the average daily spending of the 90 days before today, in whole days, rounded down. **0** when the cash is zero or below.
- **Spending is the compound's expenses** (ADR 0055: live, not voided, by their day). A vendor's payout writes its expense (ADR 0089), so that spending is counted too. Expenses, not the accounts' outgoing movements, because most spending (salaries, utilities) is recorded as an expense and moves no register money.
- **Null when it cannot be computed**, never infinite or a huge number:
  - with no live account (there is no cash position);
  - with nothing spent in the window (no outflow to divide by);
  - to anyone without `finance.cashflow`.
- **The dashboard** (ADR 0079) keeps its contract: `GET /staff/dashboard`'s `liquidityDays` is a number or null. Core's `StaffDashboard` gains a liquidity reader that finance registers, as a section; a missing one stops the start. The forecast shows the same number, beside its spending (`spending.total`, `spending.daily`).

### The minimum cash and its notice

- **`finance_settings.cash_minimum`** (positive, up to DECIMAL(14,2); null by default: no floor, no notice). Set with `PATCH /staff/finance/cash-flow/settings {minimumCash}` (`finance.treasury`), under the settings row's lock, and audited `cash_flow.settings_changed` (from, to). Null turns it off and ends a dip in course (a CHECK: a dip needs a floor).
- **The forecast** flags each period whose closing balance is below the floor (`belowMinimum`). It also shows the cash on hand below it now (`belowMinimumNow`), the first day of the first period below it (`firstBelowMinimum`) and how many periods are below it.
- **"Needs you now"** (ADR 0079) raises, to `finance.cashflow` holders:
  - `cash_below_minimum` (**critical**) when the cash on hand is below the floor now;
  - otherwise `cash_forecast_below_minimum` (warning) when a period of the default forecast (13 weeks) closes below it.
  - Their count is the number of periods below.
- **The notice `finance.cash_low`** (category finance, not critical, needs no decision). The hourly sweep `finance.cash_flow` reads the default forecast of each active compound with a floor, under its settings row's lock (`FOR UPDATE`, as the floor's change takes it). Then:
  - a dip (the cash or a week below the floor) is told **once** to the `finance.cashflow` holders, with the first day below only (`belowFrom`), **never an amount**;
  - it eases silently when the cash and the forecast are back above;
  - a new dip within **a day** of the last notice is told when the day is up, if it lasts (`cash_low_since`, `cash_low_told_at`; ADR 0079's service-pressure pattern);
  - two sweeps at once meet on the row, and the second finds the dip told.
- **Not an inbox type.** Nothing waits for a decision. It is a notice and a dashboard alert, as service pressure is.

### The realised cash flow report

- The reports platform (ADR 0086) gains **`cash_flow`** (`finance.cashflow`, added to `REPORT_READERS`). It shows what moved into and out of the compound's bank and cash accounts on the period's days, grouped **by month** (default), **by the movement's kind** or **by account**, with money in, money out and the net.
- **Openings and transfers are left out**: an opening balance and money between two of the compound's own accounts are not flows.
- It compares, draws as PDF, workbook or CSV, and schedules like every report of the platform.

### The manager dashboard

- **"Cash flow"** (`/finance/cash-flow`, `finance.cashflow`): the cash on hand, the liquidity days and the daily spending, the collection rate and what it stands on, and the minimum and when it is crossed. Then the forecast's periods (dues, expected in, out, net, closing, below the minimum), what goes out by line and what comes in by line. By week or month, with its CSV. "Minimum cash" is offered to `finance.treasury`.
- **"Overview"** shows the liquidity days to a `finance.cashflow` holder (a dash when null), and the two cash alerts.

### Registries, privacy and audit

- **Permission** `finance.cashflow`. **Notice** `finance.cash_low` (`belowFrom`, a day). **Audit** `cash_flow.settings_changed` (`minimumCash` from and to). **Report** `cash_flow`. **Alerts** `cash_below_minimum`, `cash_forecast_below_minimum`. **No new error code.**
- **Totals of the compound only.** No figure names a unit, a resident or a payer; the accounts listed are the compound's own. Nothing joins the per-account export and nothing blocks an erasure.
- **No new per-request query.** The forecast is read on its own routes, the dashboard's liquidity on the dashboard's: two aggregate queries for the days, the forecast's for the alert.

## Deviations for the owner

1. **"Guarantees" move no money.** A vendor's guarantee is its bank's promise to the compound (ADR 0089, deviation 9). Holding, returning or calling one moves nothing until the treasury records what the bank paid, so it has no line in the forecast.
2. **Overdue receivables are left out** of the inflows and shown aside. The rate measures what of the dues gets paid, and money already late is the least likely to come in a given week. Overdue payables, by contrast, fall due in the first period.
3. **Disputed dues are left out** while the dispute is open (ADR 0048 freezes them); they are shown aside.
4. **The collection rate is by invoice**, over the invoices due in the window, as paid so far. It is not cash received over the window against what fell due: that measure can pass 100 % with arrears and prepayments.
5. **No history: nothing expected** (rate null), rather than full face value or a rate taken from elsewhere.
6. **Retention leaves at the contract's end**, not at each payout. An approved invoice's or a schedule payment's cash out is net of its retention share. Advance set-offs are not forecast: how much a payout sets off is decided at the payout, so the forecast stays on the safe side.
7. **A disbursement asked for counts at once**, before its approval: it is already in the process, and a turned-down one leaves the forecast.
8. **Unscheduled spending is not forecast.** Salaries, utilities and manual expenses have no schedule in the app, so the outflows count only what payables schedules (the owner's decision 2). The daily spending of the last 90 days is shown beside the forecast for reference, and liquidity days use it.
9. **In transit: custody and cheques only.** Office bank transfers not yet matched on a statement, and online payments, have no path into the register yet (ADR 0085, deviation 6 and Deferred). They are not counted, so a compound that matches its statements late sees its cash late.
10. **A unit's credit is not netted** against its coming dues. It is money already in an account, and the invoices it will pay still count at the rate.
11. **The notice is not critical**, and is told at most once a day. The dashboard's alert is critical while the cash is below the floor now.
12. **The realised report reads the register**, so an expense recorded without a movement is not in it. The forecast's liquidity days read the expenses.

## Consequences

- One migration (`20270613090000`): `finance_settings.cash_minimum`, `cash_low_since` and `cash_low_told_at`, with two CHECKs (`finance_settings_cash_minimum`, `finance_settings_cash_low_shape`). No new table.
- `PayablesBridge`'s sources gain `unpaid` and `terms` (maintenance's `PayableSources`, no lock). `StaffDashboard` gains `registerLiquidity`; `DashboardSummary.liquidityDays` is `number | null`. `REPORT_KEYS` gains `cash_flow`, `REPORT_READERS` `finance.cashflow`.
- The sweep `finance.cash_flow` (hourly).
- The manager dashboard's "Cash flow" page; the overview's liquidity card and the cash alerts.

## Open

- Forecast against actual: last week's forecast beside what moved.
- A run rate for unscheduled spending (salaries, utilities), as an optional line the owner may turn on.
- The forecast sent on a schedule (the reports platform takes past periods; a forecast is a future one).
- Liquidity days in the daily brief (ADR 0079 stores the sections' figures; liquidity is not a section).
- A statement line matched to a payout, and online payments' settlements into the bank account (ADR 0085 Deferred), so that less money is "in transit".
- Scenarios (a delayed collection, a large repair) over the forecast.

## Update (Phase M3-5, ADR 0092)
- No change to the forecast. The general ledger's money in transit (office cash, cheques, transfers to match, online payments) is the ledger's own view of what the forecast counts in its first period.
