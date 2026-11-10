# The general ledger: backend notes for the dashboards

What was built for the general ledger (ADR 0092):
- the chart of accounts with its balances, and sub-accounts;
- an account's ledger with its running balance, and its CSV;
- the trial balance, the income statement and the balance sheet, also on the reports platform;
- the journal, its CSV for an outside accounting system, and the reconciliation with the registers;
- manual journal entries approved by a second person, and their reversal;
- months closed and reopened;
- fiscal years closed into accumulated surplus and reopened (ADR 0093, with the taxes: see [taxes.md](taxes.md)).

The design decisions are in [ADR 0092](../../decisions/0092-general-ledger.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, amounts are decimal strings in EGP with two places, days (`YYYY-MM-DD`) are the compound's, months are `YYYY-MM`. Every route here answers `Cache-Control: no-store`. ADR 0048's computed journal (`GET /staff/finance/ledger`) is unchanged.

## Who does what

- `finance.ledger` (the manager and the accountant by default): every read below.
- `finance.ledger_write` (the same): sub-accounts and names, manual entries (write, approve another's, turn down another's, withdraw one's own, reverse), closing months.
- `finance.ledger_reopen` (the manager only): reopening a month.

Nothing posts by hand except a manual entry: every money event of the app posts its own entry when it happens.

## The chart

- `GET /staff/finance/gl/accounts?asOf=` → `{ asOf, accounts: [GlAccountView] }`, by code. Each: `{ id, code, nameEn, nameAr, type, parentId, system, systemKey, cashAccountId, control, postable, debit, credit, balance }`:
  - `debit`/`credit` are its own lines up to the day; `balance` is its own and its sub-accounts' on its normal side (debit for `asset` and `expense`, credit for the rest), so a negative balance is the unusual side;
  - `postable: false` is a heading; `control: true` is kept by its register (no manual line, no sub-account); `cashAccountId` names its treasury account.
- `GET /staff/finance/gl/accounts/{id}?asOf=` → `{ asOf, account }`.
- `POST /staff/finance/gl/accounts { parentId, code, nameEn, nameAr }` → 201 the account: `code` is the parent's, a dot and one to three digits (`INVALID_FORMAT {prefix}`), once (`409 DUPLICATE_RESOURCE` on `code`); under a control account `409 GL_ACCOUNT_CONTROLLED {accountId}`.
- `PATCH /staff/finance/gl/accounts/{id} { nameEn?, nameAr? }`: names only, a system account's too.
- `DELETE /staff/finance/gl/accounts/{id}` → 204: `409 GL_ACCOUNT_SYSTEM`, or `409 GL_ACCOUNT_IN_USE {lines, children}`.

## An account's ledger

- `GET /staff/finance/gl/accounts/{id}/ledger?from&to&cursor&limit` → `{ data: [GlLedgerLineView], nextCursor }`, oldest first: `{ entryId, lineNo, postedOn, eventOn, source, sourceId, reference, debit, credit, balance, unitId, unitCode, vendorId, memo }`. `balance` is the account's own after the line; the opening balance of a period is the account's `balance` on the day before `from` (`GET …/accounts/{id}?asOf=`, which includes sub-accounts). `eventOn` differs from `postedOn` when the event's month was closed.
- `GET …/ledger/export?from&to`: CSV `posted_on, event_on, source, reference, unit, memo, debit, credit, balance`.
- A period is at most 366 days (`PERIOD_TOO_LONG`, `ENDS_BEFORE_START`).

## The statements

- `GET /staff/finance/gl/trial-balance?asOf=` → `{ asOf, rows, debit, credit, balanced }`, each row `{ accountId, code, nameEn, nameAr, type, debit, credit, amount }` with its balance on one side.
- `GET /staff/finance/gl/income-statement?from&to` → `{ from, to, revenue, expenses, totalRevenue, totalExpenses, surplus }` (negative is a deficit).
- `GET /staff/finance/gl/balance-sheet?asOf=` → `{ asOf, assets, liabilities, equity, surplus, totalAssets, totalLiabilities, totalEquity, balanced }`: `surplus` is revenue less expenses up to the day (nothing closes it into equity), and `totalEquity` includes it.
- On the reports platform (`/staff/reports/view|export?report=`): `gl_trial_balance` (`groupBy=account|type`), `gl_income_statement` (`account|type|month`), `gl_balance_sheet` (`account|type`), `gl_general_ledger` (`line`). The trial balance and the balance sheet read the period's last day.

## The journal

- `GET /staff/finance/gl/entries?from&to&source&cursor&limit` → `{ data: [GlEntryView] }`, in order: `{ id, seq, postedOn, eventOn, source, sourceId, reference, memo, lines: [{ lineNo, accountId, code, nameEn, nameAr, debit, credit, unitId, unitCode, vendorId, vendorName, memo }] }`. `source` is one of `invoice, credit_note, payment, payment_reversal, allocation, allocation_release, refund, refund_reversal, deposit, deposit_event, expense, expense_void, vendor_invoice, vendor_invoice_cancel, vendor_payout, cash_movement, custody_handin, club_payment, vehicle_fine_payment, violation_payment, manual`; `memo` is a manual entry's words.
- `GET /staff/finance/gl/entries/{id}`.
- `GET /staff/finance/gl/journal/export?from&to`: CSV for an outside system, one row a line: `entry, posted_on, event_on, source, reference, entry_memo, line, account_code, account_name, debit, credit, unit, vendor, memo` (`EXPORT_TOO_LARGE` past the export limit).

## The reconciliation

`GET /staff/finance/gl/reconciliation` → `{ asOf, balanced, debit, credit, checks, cashAccounts }`. Each check `{ key, register, ledger, difference }` with `key` one of `receivables, unit_credit, deposits_held, payables, retentions, vendor_advances`; each cash account adds `{ cashAccountId, name }`. A `difference` of `0.00` is agreement: show anything else prominently.

## Manual entries

- `POST /staff/finance/gl/manual-entries { postedOn, memo, lines: [{ accountId, debit | credit, unitId?, memo? }] }` → 201 `GlManualEntryView` `{ id, number, postedOn, memo, status, reversesEntryId, createdBy, createdAt, decidedBy, decidedAt, rejectReason, entryId, debit, credit, lines }`, `status: pending`. Refusals:
  - 2–50 lines (`INVALID_LENGTH`), each exactly one of `debit`/`credit` (`INVALID_VALUE {oneOf}`), a positive amount (`INVALID_NUMBER`);
  - `400 GL_ENTRY_UNBALANCED {debit, credit}`;
  - `404 GL_ACCOUNT_NOT_FOUND {accountId}`, `409 GL_ACCOUNT_CONTROLLED {accountId}`, `409 GL_ACCOUNT_NOT_POSTABLE {accountId}`, `404 UNIT_NOT_FOUND`;
  - `postedOn` after this month's end (`INVALID_VALUE {max}`), or in a closed month (`409 GL_PERIOD_CLOSED {month}`).
- `GET /staff/finance/gl/manual-entries?status=pending|approved|rejected|withdrawn` (newest first), `GET …/{id}`.
- `POST …/{id}/approve` (posts it; `entryId` set), `POST …/{id}/reject { reasonCode }` (`glEntryReject`): never by its maker (`409 GL_SELF_APPROVAL`); `409 GL_MANUAL_ENTRY_STATE {status}` once decided; approve in a closed month `409 GL_PERIOD_CLOSED`.
- `POST …/{id}/withdraw`: its maker only (`403 FORBIDDEN`).
- `POST /staff/finance/gl/entries/{id}/reverse { postedOn, memo }` → 201 a pending manual entry with the lines the other way round. A manual entry only (`409 GL_ENTRY_NOT_REVERSIBLE {reason: automatic|reversal}`), once (`409 GL_ENTRY_REVERSED {manualEntryId}`).
- The inbox type `gl_manual_entry` (72 h) and the notices `gl_manual_entry.submitted` (to the other holders) and `gl_manual_entry.decided` (`decision: approved|rejected`, to the maker), params `entryRef` only: open `/finance/gl/entries`.

## Months

- `GET /staff/finance/gl/periods` → `{ data: [GlPeriodView] }`, newest first from the first entry's month: `{ month, status: open|closed, ended, closedAt, closedBy, reopenedAt, reopenedBy, reopenReason }`.
- `POST /staff/finance/gl/periods/close { month }` → 201 the months: it and every open month before it. `409 GL_PERIOD_NOT_ENDED {month}` for this month or later, `409 GL_PERIOD_CLOSED {month}` when nothing is left to close.
- `POST /staff/finance/gl/periods/reopen { month, reasonCode }` (`finance.ledger_reopen`, `glPeriodReopen`) → 201 the months; `409 GL_PERIOD_NOT_CLOSED {month}`.
- An event of a closed month (a backdated payment, a late webhook) still happens: its entry is dated the next open month's first day, `eventOn` keeping its own.
