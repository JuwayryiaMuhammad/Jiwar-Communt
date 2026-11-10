# Payables and commitments (ADR 0089)

For the manager's dashboard. All routes are staff routes, every response `no-store`. Money is a decimal string with two places; no notification carries an amount.

## A budget line's figures

`BudgetView.lines[]` (and `totals`) gain `transfersIn`, `transfersOut`, `committed` (what open commitments keep), `payable` (approved invoices not yet paid) and `available` (= `remaining` − `committed` − `payable`). `allowance` now moves with the applied transfers. An expense spends only what is `available` (`409 EXPENSE_OVER_BUDGET {remaining}` carries the available). An expense a payout wrote is never voided (`409 EXPENSE_FROM_PAYOUT {invoiceId}`).

## Commitments — `finance.budget`

- Reserved by the source: a contract's unpaid schedule payments in its line's active budget year (`PUT /maintenance/contracts/{id}/payments`, a contract's `budgetLineId`), an approved purchase request's estimate on its line. Both refuse what the line cannot keep: `409 BUDGET_LINE_INSUFFICIENT {available}`.
- Given back when invoiced, changed, called off, terminated or paid by hand. A payment a live invoice names is not changed, removed or paid by hand: `409 CONTRACT_PAYMENT_INVOICED {invoiceId}`.
- `GET /staff/finance/commitments?lineId&source=contract|purchase_request&open=true|false` (paged): `CommitmentView` with `amount`, `released`, `open`, `dueOn`.

## Transfers, months and variances — `finance.budget`

- `POST /staff/finance/budget-transfers {fromLineId, toLineId, amount, reason}` (idempotent): within the manager's limit `status: applied`; above it `awaiting_board` — raise it with `POST /staff/governance/approvals {type: 'budget_transfer', budgetTransferId, context, impact}` (no `cost`: the amount is). Applied by the board's approval or `lapsed`; `rejected`, `withdrawn`. `POST …/{id}/cancel` before it is raised (`409 BUDGET_TRANSFER_STATE {status}`; `raised` once it is). `GET …?budgetId=` lists, `GET …/{id}` reads. `409 BUDGET_LINE_INSUFFICIENT {available}` past the line it leaves.
- `PUT /staff/finance/budgets/{id}/months {lines: [{lineId, months: string[12] | null} | {lineId, quarters: string[4]}]}` on the active budget: each split adds up to the line's amount (`INVALID_VALUE {count, total}`); `months: null` splits evenly again.
- `GET/PATCH /staff/finance/variance-settings {varianceReasonPct: 1–100 | null}`.
- `POST /staff/finance/budget-lines/{id}/variance-reasons {month, reasonCode, note?}` (`budgetVariance`), 204.
- `GET /staff/finance/reports/budget-periods?budgetId&by=month|quarter` (`finance.reports`) and `…/export` (CSV): per line and period `planned`, `actual`, `variance`, `variancePct`, `closed`, `reasonMissing`, `reason`; `missingReasons` in all.

## Vendors' invoices — `finance.payables` records and pays, `finance.payables_approve` decides

- `POST /staff/finance/vendor-invoices` (idempotent): `{contractId, contractPaymentId?} | {purchaseRequestId}`, `vendorId?` (for a purchase that named none), `vendorNumber`, `issuedOn` (not ahead), `dueOn`, `invoiceFileId` (purpose `expense_invoice`), `budgetLineId?`, `lines: [{description, amount, taxCode?: zero | exempt | vat_14}]`, `note?`. `409 VENDOR_INVOICE_DUPLICATE {invoiceId}` (the vendor's number among its live invoices, any case); `409 VENDOR_INVOICE_SOURCE_INVALID {reason: vendor_mismatch | not_fulfilled | paid | invoiced | not_its_contract}`; an unknown contract, payment or purchase is its own 404.
- `GET /staff/finance/vendor-invoices?status&vendorId&contractId&purchaseRequestId` (paged, newest first), `GET …/{id}`: `VendorInvoiceView` with `lines`, `invoiceUrl`, `recordedByMe`, `payout`.
- `POST …/{id}/approve {budgetLineId?, authorizationId?}`: `409 PAYABLE_SELF_APPROVAL` for its recorder; `409 BUDGET_NOT_ACTIVE`; `409 BUDGET_LINE_INSUFFICIENT {available}`; above the manager's limit `409 EXPENSE_NEEDS_APPROVAL {limit}` / `EXPENSE_AUTHORIZATION_EXCEEDED {remaining}` (its contract's or purchase's board approval is found by itself).
- `POST …/{id}/reject {reasonCode}` (`vendorInvoiceReject`), `…/cancel {reasonCode}` (`vendorInvoiceCancel`; an approved one by an approver). `409 VENDOR_INVOICE_STATE {status}`.
- `POST …/{id}/pay {paidOn, method: bank_transfer | cheque | cash, reference?, advanceSetOff?, cashAccountId?}` (idempotent): once; `payout {number, gross, retentionHeld, advanceSetOff, net, expenseId, cashAccountId}`. `409 ADVANCE_SET_OFF_EXCEEDED {open}`. What it pays leaves `cashAccountId` (ADR 0085) as a `payout` movement: a cash box for cash, a bank account otherwise (`409 CASH_ACCOUNT_WRONG_KIND {kind}`, `CASH_ACCOUNT_RETIRED`, `CASH_ACCOUNT_INSUFFICIENT {balance}`); required when net is above zero (`FIELD_REQUIRED`), refused at zero (`FIELD_NOT_ALLOWED`); `paidOn` then today or up to 31 days back (`DAY_OUT_OF_RANGE {min, max}`).
- `GET /staff/finance/payment-schedule?from&to` (either permission; next month by default): `rows[]` of `invoice` and `commitment` by day, `totals`, `overdue`.

## A contract's money

- `GET /staff/finance/contract-payables/{contractId}`: `advances`, `retention`, `invoices`, `disbursements`, `guarantees`. A contract's `retentionPct` (0–20) is set on `POST/PATCH /maintenance/contracts`.
- `POST /staff/finance/contract-payables/{contractId}/disbursements {kind: advance | retention_release, amount, note?}` (idempotent): `409 ADVANCE_EXCEEDED {max}`, `RETENTION_NOT_DUE {endsOn}`, `RETENTION_EXCEEDED {held}`.
- `GET /staff/finance/contract-disbursements` (waiting), `GET …/{id}`; `POST …/{id}/approve` (`PAYABLE_SELF_APPROVAL`, `DISBURSEMENT_NEEDS_APPROVAL {limit}`), `/reject {reasonCode}` (`disbursementReject`), `/cancel {reasonCode}` (`disbursementCancel`), `/pay {paidOn, method, reference?, cashAccountId}` (idempotent; the account as an invoice's payout takes it). `409 DISBURSEMENT_STATE {status}`.
- `POST /staff/finance/contract-payables/{contractId}/guarantees {kind, issuer, reference, amount, issuedOn, expiresOn}`; `POST /staff/finance/vendor-guarantees/{id}/close {outcome: returned | called}` (`GUARANTEE_STATE`).

## The entries export — `finance.reports`

`GET /staff/finance/reports/entries/export?from&to` (at most 366 days): CSV `date, kind, reference, id, vendor_id, vendor, category, budget_line_id, amount, tax, retention, advance_set_off, net, detail`, one row per money event: `expense`, `expense_void`, `invoice_approved`, `invoice_cancelled`, `payout`, `commitment`, `commitment_release`, `budget_transfer`, `budget_increase`; signed.

## The inbox and notifications

Inbox types `vendor_invoice` and `contract_disbursement` (`finance.payables_approve`, 72 h, amount against the major contract threshold). Notifications (category `finance`): `vendor_invoice.received` (invoiceRef, needs a decision), `vendor_invoice.decided` (invoiceRef, decision), `contract_disbursement.requested` (disbursementRef, disbursementKind, needs a decision), `vendor_guarantee.expiring` (guaranteeKind, expiresOn). Links: `/finance/payables/{id}`, `/finance/payables/contracts`.

## Schema names

Three of this module's contract classes shared a name with older ones, and Swagger keys a schema by its class name: the vendor invoice's line replaced the residents' invoice line (`InvoiceLineDto`) in `openapi.v0.json`, the generated client and Postman. They are renamed, the residents' `InvoiceLineDto` is back as it was, and no request or response changes shape:

- `InvoiceLineDto` → `VendorInvoiceLineDto` (the lines of `POST /staff/finance/vendor-invoices`);
- `PeriodQueryDto` → `PaymentScheduleQueryDto` (`GET /staff/finance/payment-schedule`);
- `EntriesQueryDto` → `FinanceEntriesQueryDto` (`GET /staff/finance/reports/entries/export`).

## Taxes (ADR 0093)

- A vendor invoice's tax (its lines' `taxCode`) is input VAT: at its approval `vatRecoverable` is set — its tax while the compound is registered for VAT and the line's category is marked recoverable, else `0.00` (the tax stays part of the cost). `withholdingCategory` (`supplies | services | professional | exempt`, null: its vendor's) may be named when recording it.
- A payout, while withholding is on, deducts the tax withheld from what it pays: `payout.withholding`, `withholdingRate`, `withholdingBase`, `withholdingCategory`; `net` is after it; its certificate (`WHT-`) is written with it. See [taxes.md](taxes.md).
