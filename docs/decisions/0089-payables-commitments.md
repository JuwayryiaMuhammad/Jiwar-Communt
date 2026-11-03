# 0089 — Payables and commitments: vendors' invoices approved against the budget line and paid once into their expense, the budget a contract's payments and an approved purchase keep, transfers between lines, a line's months and its variances, advances, retentions and guarantees, the payment schedule and an entries export for the ledger to come

**Status:** Accepted · Phase M3-1 · amends ADR 0055 (a line's available, expenses held to it, a payout's expense never voided, `budget_transfer` for the board), 0073 (two inbox types), 0077 (contracts and purchases reserve their line; a payment an invoice names stays; a contract's retention share)

## Context

The finance audit (slice 05, 2026-11-01) found the compound paying its suppliers outside the app: an expense was written after the money was spent (ADR 0055), nothing was approved for payment, a contract's payment schedule (ADR 0077) was marked paid by hand, and an approved contract or purchase reserved nothing of its budget line, so the same money could be spent twice. The budget was yearly only, with no transfer between lines and no reason asked for a line past its plan. The owner approved the plan and every recommendation (2026-11-01): **no double-entry ledger yet; export the entries** (M3-5 decides later); payables-lite (no purchase order); tax codes on lines, zero by default.

The model is ADR 0055's and 0077's: rules checked under locks by the database's clock, rows moving forward only by trigger, codes outside what people write, money as two-place `DECIMAL` (as the repo stores it, ADR 0046), every response `no-store`, every table under RLS, forced, with composite keys.

## Decisions

### Where it lives

- **In finance** (`src/finance/payables`): the money. Finance imports no domain (ADR 0046) and nothing imports finance (ADR 0055), so **core's `PayablesBridge`** (`src/core/payables`) is where it meets maintenance, as `BoardMatters` and `VendorDirectory` are: finance registers the **commitment keeper** (`sync`, `assertNotInvoiced`), maintenance the **sources** (a contract, a payment of its schedule, a purchase request, each read under its row lock; a payment settled by a payout). A missing one stops the start.

### Permissions

- `finance.payables` (staff, manager; the manager and the accountant): record vendors' invoices, ask for an advance or a retention's release, keep guarantees, pay out what was approved.
- `finance.payables_approve` (staff, manager; the manager): approve or turn down invoices and requests, return or call a guarantee.
- Both are `finance.*`: a deputy never holds them (ADR 0073). Transfers, months, variance reasons and commitments are `finance.budget`; the period report and the entries export `finance.reports`. `access:sync` brings the two new ones to existing compounds.

### A line's figures (amends ADR 0055)

- **allowance** = amount + approved increases + applied transfers in − out; **remaining** = allowance − live expenses (budget vs actual as before); **committed** = what open commitments still keep; **payable** = approved invoices not yet paid; **available** = remaining − committed − payable.
- A manual expense spends only what is **available** (`EXPENSE_OVER_BUDGET` with `params.remaining` = available). Every writer of a line's money — an expense, a transfer, a commitment, an invoice's approval, a payout — locks the lines' budgets shared and the lines for update, in id order, then decides by what it reads after them.

### Commitments (20270601090100)

- **What reserves:** a contract's unpaid schedule payments whose day falls in its line's **active** budget's year, one commitment a payment; an **approved** purchase request's estimate on its line. Reserved in the source's own transaction, after its row lock, within what the line has available (`409 BUDGET_LINE_INSUFFICIENT {available}`): a schedule the line cannot keep, or a purchase it cannot, is refused whole.
- **Released**, by append-only rows, never past the amount, the commitment closed exactly when released whole (checked at commit): `invoiced` (by an approved invoice — a contract payment's whole, a purchase's up to the invoice), `changed` (the schedule or the line changed), `cancelled` (the purchase called off), `terminated` (the contract), `paid_outside` (a payment marked paid by hand).
- **One open commitment an item** (partial unique keys). A payment a live vendor invoice names is not changed, removed or paid by hand (`409 CONTRACT_PAYMENT_INVOICED {invoiceId}`); its commitment is left to the invoice.
- `GET /staff/finance/commitments?lineId&source&open` lists them with what each still keeps.

### Vendors' invoices (20270601090200)

- **Recorded** (`POST /staff/finance/vendor-invoices`, idempotent, `VI-` numbers) against one of a vendor's contracts (`contractId`, optionally `contractPaymentId`, a payment not paid and not invoiced) or a purchase request it **fulfilled** (`409 VENDOR_INVOICE_SOURCE_INVALID {reason}`: `vendor_mismatch | not_fulfilled | paid | invoiced | not_its_contract`; an unknown source is its own 404). Its vendor is its source's (a purchase that named none names one of the register, not suspended). With its scan (an `expense_invoice` file, ADR 0055, the caller's upload), its dates, a note, and **lines with a tax code** (`zero` by default, `exempt`, `vat_14`), adding up to its subtotal and tax at commit.
- **The vendor's number once among its live invoices**, whatever its case: an advisory lock on the vendor and the lowercased number, then the check (`409 VENDOR_INVOICE_DUPLICATE {invoiceId}`), backed by a unique expression index. A rejected or called-off invoice frees it.
- **`channel`** (`office`): the contractor portal (M2-7, ADR 0088) adds its own value and intake on this table.
- **Approved** (`finance.payables_approve`) by **someone who did not record it** (`409 PAYABLE_SELF_APPROVAL`, even with the board's approval), on a line of the active budget (its source's, or one named): its item's commitment is released first, then the line must have the rest **available**. Above the manager's limit (`major_contract`'s threshold, ADR 0055, always binding, ADR 0073) it needs the board's approved major contract — **its contract's or purchase's**, found at its record, or one named — whose authorization it **holds** until paid, as an expense spends it (`EXPENSE_NEEDS_APPROVAL {limit}`, `EXPENSE_AUTHORIZATION_EXCEEDED {remaining}`): one path, the same authorization, the same codes. Within the limit `authorizationId` is `FIELD_NOT_ALLOWED`.
- **Turned down** (`vendorInvoiceReject`) or **called off** (`vendorInvoiceCancel`: a received one by either permission, an approved one by an approver; what its approval released stays released). Forward only (a trigger): received → approved | rejected | cancelled; approved → paid | cancelled.
- The approvers are told it waits (`vendor_invoice.received`, needs a decision); its recorder the decision (`vendor_invoice.decided`). Never an amount in the params.

### Paying out (20270601090300)

- **`POST /staff/finance/vendor-invoices/{id}/pay {paidOn, method, reference?, advanceSetOff?}`** (`finance.payables`, idempotent): once (`VP-` numbers; one payout an invoice, one expense an invoice, both by unique keys, under the invoice's lock after the contract's and the payment's). It **writes the ADR 0055 expense** on its line, under its authorization, at the invoice's total, on the paid day (within the line's budget year, not ahead), naming the invoice (`vendor_invoice_id`, once): budget vs actual stays one source. Such an expense is **never voided** (`409 EXPENSE_FROM_PAYOUT`; the expense trigger is recreated whole).
- It **holds back the contract's retention** (`retention_pct`, at most 20 %, a contract's term) and **sets off its open advances** as asked (`409 ADVANCE_SET_OFF_EXCEEDED {open}`); what is paid is the rest (`net`, a CHECK). A schedule payment is marked paid with the payout's number.
- **How it was paid** is a method (`bank_transfer | cheque | cash`) and a reference for now. **The treasury (M3-2, ADR 0085) plugs in at the rebase**: a payout names the cash account it moved through (`cash_account_id`), and paying out writes a new movement kind, `payout`, of minus its net on that account under the account's lock (after the lines', before the counters), a cash box never below zero (`CASH_ACCOUNT_INSUFFICIENT`); a bank statement line then matches it.

### Advances, retentions and guarantees

- **An advance** or **a retention's release** on a contract (`VD-` numbers, `POST /staff/finance/contract-payables/{contractId}/disbursements`): asked for by `finance.payables`, approved by a `finance.payables_approve` holder **who did not ask** (also a CHECK); above the manager's limit only on a contract the board signed (`409 DISBURSEMENT_NEEDS_APPROVAL {limit}`). An advance within what the contract's value leaves after what was advanced, asked and invoiced (`ADVANCE_EXCEEDED {max}`); a release only after the contract's end or termination (`RETENTION_NOT_DUE {endsOn}`), within what is held and not yet asked (`RETENTION_EXCEEDED {held}`). Turned down (`disbursementReject`), called off (`disbursementCancel`), **paid once, whole** (a payout with no expense: an advance is spent by the invoices it is set off against, a retention was spent with its invoice).
- **A guarantee** (performance, advance payment, warranty) its vendor's bank gives: issuer, reference, amount, dates; kept, then returned or called once (`GUARANTEE_STATE`); its expiry told to `finance.payables` 30 days ahead, once (`finance.vendor_guarantees`, hourly).
- `GET /staff/finance/contract-payables/{contractId}` shows the contract's advances (paid, set off, open, asked), retention (held, released, asked, open), invoices, requests and guarantees. Every money row of a contract is written under its row lock (maintenance's, through the bridge): two payouts never set off the same advance, two releases never the same retention.

### Budget planning (20270601090000)

- **Transfers** (`POST /staff/finance/budget-transfers`, `finance.budget`) between two lines of the active budget, at most what the line it leaves has **available**. Within the manager's limit: applied at once. Above it: `awaiting_board`, and a **`budget_transfer`** request names it (`budgetTransferId`, its amount the cost; the approval type's CHECKs widened, a deadline row for every compound); the board's approval applies it under both lines' locks, or **lapses** it when the line no longer has the money; rejected or withdrawn, it is final. Called off before it is raised (`POST …/{id}/cancel`); after, governance withdraws it. Terms fixed, forward only (a trigger).
- **A line's months** (`PUT /staff/finance/budgets/{id}/months`, the active budget): twelve months, or four quarters each spread a third on its months, adding up to the line's amount (at commit); a line with none is split evenly when read.
- **The period report** (`GET /staff/finance/reports/budget-periods?budgetId&by=month|quarter`, and its CSV): planned (the months' share, plus the increases and transfers each month brought, by their day), actual (live expenses by their day), the variance and its percentage. **`finance_settings.variance_reason_pct`** (`GET/PATCH /staff/finance/variance-settings`, null by default): past it, a closed period without a reason is `reasonMissing`; `POST /staff/finance/budget-lines/{id}/variance-reasons {month, reasonCode, note?}` (`budgetVariance`) records why, append-only, the latest showing.

### The payment schedule and the entries export

- `GET /staff/finance/payment-schedule?from&to` (either payables permission): approved invoices by their due day and what commitments keep by theirs, **next month by default** (next month's commitments), at most 366 days, with the overdue count and amount.
- `GET /staff/finance/reports/entries/export?from&to` (`finance.reports`, CSV, at most 366 days and the export row limit): **every money event of the period once, from its own row**, by the compound's day — an expense and its void, a vendor invoice approved and one called off after it, a payout (gross, retention, set-off, net, how), a commitment and each release, an applied transfer, an approved increase — signed, with its reference, vendor, line and category. What a ledger (M3-5) would post from.

### The staff inbox (amends ADR 0073)

Two types, both CHECKs widened: `vendor_invoice` (a received invoice) and `contract_disbursement` (a requested advance or release), each to `finance.payables_approve`, 72 h, with its amount against the major contract threshold; never approved in bulk (an approval names a line and may need the board's).

### Lock order

The caller → the contract, then its payment or the purchase request (update, maintenance's) → the vendor (shared) → the vendor's number (advisory) → the invoice, the request, the transfer or the guarantee (update) → the lines' budgets (shared) and the lines (update, in id order) → the threshold's row (shared) → the authorization (update) → the counters (`expense`, `vendor_invoice`, `disbursement`, `payout`, after the deposit's in the one order). Maintenance's own paths keep theirs and call the keeper after their row lock: a contract (update) → … → the lines.

### Registries, privacy and audit

- **Errors:** `BUDGET_LINE_INSUFFICIENT`, `BUDGET_TRANSFER_*`, `VENDOR_INVOICE_*`, `PAYABLE_SELF_APPROVAL`, `DISBURSEMENT_*`, `ADVANCE_*`, `RETENTION_*`, `GUARANTEE_*`, `CONTRACT_PAYMENT_INVOICED`, `EXPENSE_FROM_PAYOUT`. **Reasons:** `vendorInvoiceReject`, `vendorInvoiceCancel`, `disbursementReject`, `disbursementCancel`, `budgetVariance` (mirrored in `packages/api/src/reasons.ts`, each in its CHECK).
- **Notifications** (category `finance`, references and codes, never an amount): `vendor_invoice.received` (needs a decision), `vendor_invoice.decided`, `contract_disbursement.requested` (needs a decision), `vendor_guarantee.expiring`.
- **Audit** (ids, numbers, codes, amounts, days): `budget_transfer.applied|requested|decided|cancelled`, `budget.phased`, `budget_line.variance_explained`, `finance_commitment.reserved|released`, `vendor_invoice.recorded|approved|rejected|cancelled`, `contract_disbursement.requested|approved|rejected|cancelled`, `vendor_payout.recorded`, `vendor_guarantee.recorded|returned|called`, and the payout's `expense.recorded`; an invoice's and a request's note, a transfer's reason, a variance's note, a payout's reference and a guarantee's issuer and reference as `{ changed }`.
- **Privacy:** a vendor is a company (ADR 0077): its invoices, payouts and guarantees are the compound's financial records, kept; the staff they name are named as a payment's recorder is (ADR 0046). Nothing joins the per-account export and nothing blocks an erasure. **No new per-request query.**

## Deviations for the owner

1. **Money as `DECIMAL(14,2)`**, as the repo stores it (ADR 0046, and M3-2's deviation 1), not integer minor units.
2. **No self-approval, even under the board's approval** (stricter than ADR 0077's purchases): who recorded an invoice or asked for an advance never approves it. A compound with a single manager and no second approver must give `finance.payables_approve` to another staff role.
3. **A contract reserves only its schedule**: a contract with no payment schedule, or payments outside its line's active budget year, reserves nothing; its annual value is not spread by itself.
4. **An approved invoice called off** does not restore the commitment it released; saving the contract's schedule again reserves what is still unpaid.
5. **"Approval against the budget line with ADR 0055 thresholds and M2-3's binding authority"** is read as `major_contract`'s threshold (the manager's limit, always binding) and the board's major contract authorization, the expenses' own path. Role limits under the manager's (ADR 0073 deviation 2) are not built.
6. **Variance reasons "required"** means the period report and the budget planning page flag every closed period past the setting without one (`reasonMissing`, `missingReasons`); nothing is blocked, and it is not an inbox type.
7. **Quarterly budgets are their months'**: a quarter's split is stored as three months (a third each).
8. **An invoice's payout pays its total at once**; part payments of one invoice are not modelled. Payout reversal is not built (an expense a payout wrote is never voided); a mistaken payout is corrected by the treasury's adjustment once M3-2 lands.
9. **Guarantees are records**, not money: calling one moves nothing until the treasury records what the bank paid.
10. **Retention and advances on contracts only**, not on purchase requests; the retention share is the contract's term (`retention_pct`), applied at each payout.

## Consequences

- Four migrations (`20270601090000`…`090300`); ten tenant tables under RLS, forced, with composite keys; every CHECK on the review list, every unique index mapped; `finance_settings.variance_reason_pct`, `finance_expenses.vendor_invoice_id`, `maintenance_contracts.retention_pct`; the expense's and the contract's triggers recreated whole; the counters', the inbox's and the approval types' CHECKs widened.
- `BudgetsService`'s figures read transfers, commitments and payables (`LINE_SUMS`); the budget view and the board's `budget_increase` description show them.
- Maintenance's contracts (schedule, line change, termination, a payment paid by hand) and purchase requests (approval, cancel) call the keeper after their row lock.
- Races designed out, each in `payables/payables-concurrency`: two approvals of one invoice, one invoice paid twice, a purchase's commitment against a transfer on one line, one vendor's number twice.
- M2-7 adds the contractor's invoice intake (`channel`); M3-4 reads the schedule and the commitments for cash flow; M3-5 posts from the entries.

## Open

- Purchase orders, goods receipts and the three-way match (owner's decision 6: lite first).
- Withholding tax on vendor payments and the VAT return (the tax codes are in place, zero by default).
- Paying from a bank or cash account: at the rebase onto M3-2.
