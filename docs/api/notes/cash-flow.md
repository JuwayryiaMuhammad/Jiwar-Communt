# Cash flow and liquidity: backend notes for the dashboards

What was built for the cash flow forecast and liquidity (ADR 0091):
- the forecast, by week or month, and its CSV;
- the compound's minimum cash and its notice;
- the dashboard's liquidity days and cash alerts;
- the realised cash flow report.

The design decisions are in [ADR 0091](../../decisions/0091-cash-flow-and-liquidity.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, amounts are decimal strings in EGP with two places, days (`YYYY-MM-DD`) are the compound's. Every route here answers `Cache-Control: no-store`.

## Who reads what

- `finance.cashflow` (the manager and the accountant by default) reads the forecast, its CSV, the settings, the `cash_flow` report and the dashboard's `liquidityDays`, and is told `finance.cash_low`.
- `finance.treasury` sets the minimum cash (and reads the settings).

## The forecast: `GET /staff/finance/cash-flow`

Query: `by` = `week` (default; the compound's weeks, Saturday to Friday) or `month`; `periods` = 13 weeks or 6 months by default, at most 26 weeks or 12 months (`400 INVALID_NUMBER {min, max}`). The first period starts today and may be short.

`{ asOf, timeZone, currency, by, opening, collection, spending, liquidityDays, minimumCash, belowMinimumNow, firstBelowMinimum, periodsBelowMinimum, overdue, disputed, periods, totals }`:

- `opening`: `{ total, accounts: [{ id, name, kind, balance }] }`, the live bank and cash accounts. `total` is the cash on hand.
- `collection`: `{ rate, basis, from, to, due, collected }`:
  - `rate` (0–1, three places) = `collected` ÷ `due`, over the invoices due in the 90 days before today (`from`–`to`);
  - `basis: no_history` with nothing due there: `rate` is null and `expected` is 0 everywhere. Show "no collection history yet".
- `spending`: `{ from, to, total, daily }`: live expenses of the same 90 days, and `total ÷ 90`.
- `liquidityDays`: `opening.total ÷ spending.daily`, whole days, or null (no account, nothing spent). Show a dash for null.
- `periods[]`: `{ from, to, inflows, outflows, net, closing, belowMinimum }`:
  - `inflows`: `invoiced` (issued and owed), `projected` (the billing plans' periods not issued yet), `dues` (their sum, at face), `expected` (dues × rate), `inTransit` (custody and uncleared cheques, the first period only), `total` (expected + inTransit);
  - `outflows`: `vendorInvoices`, `contractPayments` (each less its retention), `purchases`, `disbursements` (advances and releases asked or approved, the first period), `retentions` (at the contract's end), `total`;
  - `net` = inflows − outflows; `closing` = the opening plus every net so far.
- `overdue.payables`: `{ count, amount }`, past their day and counted in the first period; `overdue.receivables` and `disputed`: residents' dues past their day or under dispute, **not counted**.
- `minimumCash` (null: none), `belowMinimumNow`, `firstBelowMinimum` (the first day of the first period closing below it), `periodsBelowMinimum`.
- `totals`: `{ inflows, outflows, net, closing }` (the last closing).

`GET /staff/finance/cash-flow/export` takes the same query and answers a CSV, one row a period: `from, to, invoiced, projected, expected, in_transit, inflows, vendor_invoices, contract_payments, purchases, disbursements, retentions, outflows, net, closing, below_minimum`. Fetch it through the BFF, as the other exports.

## The minimum cash

- `GET /staff/finance/cash-flow/settings` (`finance.cashflow` or `finance.treasury`): `{ minimumCash, lowSince, toldAt }`.
- `PATCH /staff/finance/cash-flow/settings` (`finance.treasury`): `{ minimumCash: "50000.00" | null }`. It takes up to 12 digits and two places, and is positive (`INVALID_FORMAT`). Null turns the floor and its notice off. Audited `cash_flow.settings_changed`.
- The notice `finance.cash_low` (params `belowFrom`, a day; target `cash_flow`, the compound) goes to the `finance.cashflow` holders once a dip, at most once a day: open `/finance/cash-flow`.

## The dashboard

- `GET /staff/dashboard`'s `liquidityDays` is now a number for a `finance.cashflow` holder, and null without the permission, with no account or with nothing spent in 90 days.
- `GET /staff/dashboard/needs-you` gains two alerts of section `finance`:
  - `cash_below_minimum` (critical): the cash on hand is below the minimum now;
  - `cash_forecast_below_minimum` (warning): a week of the 13-week forecast closes below it.
  - Their `count` is the number of periods below.

## The report

`GET /staff/reports/view?report=cash_flow&groupBy=month|kind|account` (ADR 0086): money in, money out and the net of the accounts' movements on the period's days, openings and transfers between accounts left out. It compares, exports and schedules like the other reports.
