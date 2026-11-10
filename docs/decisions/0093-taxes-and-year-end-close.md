# 0093 — Taxes and the fiscal year-end close: VAT on a unit's invoices while the compound is registered, input VAT recovered by category, the monthly declaration from the closed ledger, tax withheld from vendors' payouts with its certificate, taxes paid from the treasury, and a fiscal year closed into accumulated surplus and reopened by the manager

**Status:** Accepted · Phase M3-6 · amends ADR 0010 (the three ledger permissions cover it), 0046 and 0048 (an invoice and its credit notes carry VAT), 0055 (the fiscal year's first month is fixed by a closed year), 0077 (a vendor's withholding category), 0085 (a tax paid is a movement), 0086 (two reports), 0089 (a vendor invoice's tax and a payout's withholding), 0092 (the year-end close, built; three accounts; the balance sheet)

## Context

ADR 0089 recorded a vendor invoice's tax as part of its cost ("no VAT return yet"), ADR 0092 posted every money event but left the year-end close to a manual entry, and a unit's invoice carried no tax. The owner decided on 2026-11-10 to build three things: VAT and its monthly declaration, withholding tax on vendor payments, and the fiscal year-end close. The owner gave neither rates nor legal rules and said they can change, so **wherever the law or a rate is involved it is a compound setting with a sensible Egyptian default**, and each default is recorded below as an assumption.

**Existing data has no VAT.** Nothing is reposted: VAT starts on the day a compound first turns it on (`vatSince`), withholding from the next payout, the close from its first act.

## Decisions

### The settings (`finance_settings`, `GET|PATCH /staff/finance/tax/settings`)

- **VAT:** registered or not (**off by default**), the registration number (required while registered: `FIELD_REQUIRED`), the rate (**14 %**, above 0 and at most 100), the invoice kinds that carry it (**none by default**), the budget categories whose input VAT is recovered (**none by default**). Turning VAT on the first time sets `vatSince` to that day.
- **Withholding:** on or off (**off by default**), the rate for supplies (**1 %**), for services and contracting (**3 %**), for professional fees (**5 %**), and the least invoice subtotal it applies to (**300 EGP**).
- **The fiscal year's first month** (default January) is ADR 0055's `fiscalYearStartMonth`, as it was; it is fixed once a budget was submitted **or a fiscal year was closed** (`FISCAL_YEAR_LOCKED`).
- A change applies from the next event; nothing is reposted. Every change is audited (`tax_settings.updated`: codes, rates, amounts; the registration number only as `{ changed }`).
- Read with `finance.ledger`, kept with `finance.ledger_write` (below).

### VAT on a unit's invoice

- **Taxable per kind.** The kinds are the invoice kinds the compound bills (service charge, maintenance, facility, club, fine, damage, other). While the compound is registered, **each line of an invoice of a taxable kind carries its VAT**, rounded per line (`round(amount × rate / 100)`); an untaxed kind carries none. The invoice shows **net, VAT and gross**: a line's `amount` is its net, `total` stays what the unit owes (net plus VAT), and the invoice's `vat` is the lines' sum at the `vatRate` it was issued at. A CHECK at commit keeps lines and invoice in step.
- **A credit note takes back its share** of the invoice's VAT: the amount's share, never more than is left, and what is left when it credits the invoice whole. It is set by the database, whatever path wrote the note. An instalment plan's credit note and its remainder carry the VAT the note took back (each instalment its share, the last the rest). An invoice cancelled whole (by a credit note for all of it) takes back all of its VAT.
- **The ledger.** An invoice credits its kind's revenue with the net and **VAT payable** (2700) with the VAT; a credit note takes both back. The three new system accounts are control accounts, in every compound's chart now: **1500 VAT recoverable**, **2700 VAT payable**, **2800 withholding tax payable** (3200 accumulated surplus is ADR 0092's).

### VAT on a vendor's invoice

- **The tax the vendor charged is recorded as input VAT** on the invoice (ADR 0089's tax codes). At its **approval** the invoice takes `vatRecoverable`: its tax, while the compound is registered and its line's category is marked recoverable; otherwise 0, and **the tax stays part of the cost**, as ADR 0089 had it. It is set by the database at the approval and kept, so a later change of settings never moves an approved invoice.
- **The ledger.** An approved invoice debits its category with what is not recovered and **VAT recoverable** with what is; payables hold the whole. A call-off reverses both.

### The monthly declaration (`finance_vat_declarations`)

- **The month's figures** come from the ledger by its entries' days: taxable sales (revenue net on the taxed invoices less credit notes), output VAT, taxable purchases (expense net of the VAT recovered), input VAT. `GET /staff/finance/tax/vat/months` lists them newest first, from the month VAT began (at most 36): `open` (the ledger has not closed it), `ready` (closed, not declared) or `declared`.
- **Declared** (`POST /staff/finance/tax/vat/declarations {month}`, `finance.ledger_write`): a month the ledger **closed** (`TAX_MONTH_NOT_CLOSED`), **the next one in order** from the month VAT began (`TAX_MONTH_OUT_OF_ORDER {next}`), **once** (`TAX_MONTH_DECLARED`). The figures are written to the declaration, which **locks them**; the input is set off against the output and what the month before carried forward: **due**, or **carried forward** to the next month, never both. A declared month is not reopened in the ledger (`TAX_MONTH_DECLARED`, and the database). The declaration posts: VAT payable less VAT recoverable (up to what is due).
- **Settled** (`POST /staff/finance/tax/payments {kind: vat, declarationId, …}`): a payout from a treasury account of the method's kind (ADR 0085: a cash box for cash, a bank account otherwise) against VAT payable, at most what is still due (`TAX_PAYMENT_EXCEEDED {open}`), many payments allowed. It is a `tax_payment` movement on the account, `TXP-` numbered.
- **The report** is `tax_vat` on the reports platform (ADR 0086): by month or by source, PDF, workbook and CSV, compared and scheduled, to `finance.ledger`.

### Withholding on vendor payouts

- **The category.** A vendor invoice names the category (`withholdingCategory`, optional), else its vendor does (`PUT /staff/finance/tax/vendors/{id}`), else it follows the vendor's trades (professional if it has that trade, supplies if that is all it does, else services). **Exempt** withholds nothing.
- **At a payout** of a vendor invoice, while withholding is on: the category's rate on the invoice's **subtotal** (net of tax) when the subtotal reaches the threshold, rounded to the piastre. It is **deducted from what is paid** (`net = gross − retention − advance set off − withholding`; an advance set off may not exceed what remains), recorded on the payout with its rate, base and category, and posted to **withholding tax payable** (2800). An advance or a retention release never withholds.
- **The certificate** (`finance_withholding_certificates`, `WHT-`) is written with the payout, once, and checked at commit: the vendor's name and tax number, the payout and invoice numbers, the category, the rate, the base, the amount. `GET …/withholding/certificates[/{id}]` and **`…/{id}/pdf`** (drawn on demand, never stored) give it to the vendor.
- **The quarterly report.** `GET …/withholding/quarters` lists the calendar quarters (at most 16): withheld by the certificates' days, paid, and still due. The `tax_withholding` report lists the certificates by vendor (name and tax number, as the quarterly return lists them), category or month.
- **Settled** with `POST …/payments {kind: withholding, quarter, …}`, a calendar quarter not ahead, at most what is still due; against 2800.

### The fiscal year-end close (`gl_year_closes`)

- **Years.** `GET /staff/finance/gl/years` lists the fiscal years from the first entry's to this one, newest first: open or closed, whether it is closable, its open months, and the live close.
- **Closed** (`POST /staff/finance/gl/years/close {startsOn}`, `finance.ledger_write`) once **every month of it is closed** (its last one included, so it has ended: `GL_YEAR_MONTHS_OPEN {months}`) **and every earlier year with entries is** (`GL_YEAR_PREVIOUS_OPEN`). One **closing entry**, dated the year's last day, zeroes each revenue and expense account into **3200 accumulated surplus** (nothing to close posts no entry). The close keeps the year's revenue, expenses and result. **The year is locked**: its months are not reopened (`GL_YEAR_CLOSED`, and the database), and the fiscal year's first month is fixed.
- **Reopened** (`POST …/years/reopen {startsOn, reasonCode}`) by **the manager alone** (`finance.ledger_reopen`) with a `glPeriodReopen` reason, the **latest closed year first** (`GL_YEAR_LATER_CLOSED`): the closing entry is reversed on the same day. Its months stay closed until the manager reopens one; the year may be closed again.
- **The statements.** The **balance sheet** shows the fiscal year's result to the day (`currentYearResult`, from `fiscalYearStartsOn`) **apart from accumulated surplus**, and the results of earlier years not yet closed (`priorYearsResult`); `surplus` is their sum. The **income statement** of a closed year still reads its own revenue and expenses: closing entries are left out of both statements and of the period's totals, so the lines before them speak.
- **Not backfilled.** A close is an act of the manager and the accountant, not history.

### Permissions, registries, privacy

- **No new permission.** Reading (settings, vendors' categories, months, quarters, certificates, payments, years) is **`finance.ledger`**; keeping the settings, a vendor's category, declaring, paying and closing a year is **`finance.ledger_write`**; reopening a year is **`finance.ledger_reopen`**, the manager's alone, as for a month. A separate tax permission would split an accountant's one job, and the manager's alone for the reopen is the owner's rule.
- **Errors:** `TAX_VAT_NOT_REGISTERED`, `TAX_MONTH_NOT_CLOSED`, `TAX_MONTH_DECLARED`, `TAX_MONTH_OUT_OF_ORDER`, `TAX_DECLARATION_NOT_FOUND`, `TAX_PAYMENT_EXCEEDED`, `WITHHOLDING_CERTIFICATE_NOT_FOUND`, `GL_YEAR_MONTHS_OPEN`, `GL_YEAR_PREVIOUS_OPEN`, `GL_YEAR_CLOSED`, `GL_YEAR_NOT_CLOSED`, `GL_YEAR_LATER_CLOSED`. **Counters:** `withholding_certificate` (`WHT-`), `tax_payment` (`TXP-`).
- **Audit** (ids, codes, rates, days and amounts only): `tax_settings.updated`, `vendor.withholding_category_set`, `vat_declaration.declared`, `withholding_certificate.issued`, `tax_payment.recorded`, `gl_year.closed`, `gl_year.reopened`.
- **Privacy.** A certificate names a vendor, the compound's own record, and a company's tax number is not a person's. No resident's data joins a declaration or a report; a unit's VAT is on its own invoice. Every response is no-store (the compound's books). No new per-request query.

## Assumptions (recorded for the owner; the owner gave no rates or rules)

1. **VAT is off by default** (14 % when on): most Egyptian residential service charges are outside VAT, and the compound decides.
2. **No kind is taxable by default**, and the kinds are the invoice kinds; a finer flag per fee item is not built. Marking a kind taxable applies to invoices issued after.
3. **Prices are net, VAT is added** (a line's amount is its net; the total is net plus VAT), rounded per line.
4. **No category's input VAT is recoverable by default**: the VAT a vendor charges stays part of the cost until the compound registers and marks the category.
5. **VAT begins the day it is first turned on**; turning it off stops charging it but keeps `vatSince`, and the declarations already made.
6. **A month is declared after the ledger closes it, in order, once**; a credit position is **carried forward**, not refunded; a payment may be in parts.
7. **Withholding defaults:** supplies 1 %, services and contracting 3 %, professional fees 5 %, on the invoice subtotal (net of tax), from 300 EGP. The rates and the threshold are the compound's to change.
8. **A vendor's category** is the invoice's, else the vendor's, else by its trades: a vendor with several trades is a service provider unless it is professional.
9. **Quarters are calendar quarters**; withholding is reported and paid by the certificate's day.
10. **The compound is the withholding agent for vendor invoices only**: salaries, deposits and refunds are never withheld.
11. **A fiscal year is twelve months from the first of the start month**; the close needs every month closed and every earlier year closed, so the books are finished in order.
12. **The close is one entry on the year's last day**; reopening reverses it on that day and leaves the months closed.
13. **Taxes are paid from the treasury** like a payout: a cash box or a bank account of the method's kind, and a `tax_payment` movement the account's balance and the ledger's reconciliation both hold.

## Consequences

- Three migrations (`20270617090000`…`090200`): new columns on settings, invoices, credit notes, vendors, vendors' invoices and payouts; four tables (certificates, declarations, tax payments, year closes) under RLS, forced, with composite keys; the invoice and credit note checks recreated whole; the postings recreated by the rules above and the backfill function by the same; the counters' and the ledger's source CHECKs stated last with every value before them.
- `REPORT_KEYS` gains `tax_vat` and `tax_withholding`; the treasury movement kinds gain `tax_payment`.
- The manager's pages: "Tax settings", "VAT declaration", "Withholding tax", and the fiscal years on "Closing months".
- A test-only superuser write with `session_replication_role = replica` posts nothing, as before.

## Open

- Filing with the tax authority (the e-invoice and e-receipt systems, the return's own forms): the declaration is the figures, not the filing.
- A taxable flag per fee item, VAT on deposits and on refunds, a reverse charge, other taxes (income, stamp duty) and withholding on payments other than vendor invoices.
- A refund of a VAT credit instead of carrying it forward.
- A year closed in parts (a short first year, a changed start month after a close).
