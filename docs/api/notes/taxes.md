# Taxes and the year-end close: backend notes for the dashboards

What was built (ADR 0093):
- the tax settings: VAT and withholding, with their rates and rules as the compound's;
- VAT on a unit's invoices and credit notes, and the VAT a vendor's invoice recovers;
- the monthly VAT declaration, and the taxes paid from the treasury;
- withholding on vendors' payouts, its certificate as PDF and its quarterly report;
- the fiscal year closed into accumulated surplus, and reopened by the manager.

The design decisions are in [ADR 0093](../../decisions/0093-taxes-and-year-end-close.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, amounts are decimal strings in EGP with two places, rates are percent strings with two places, days (`YYYY-MM-DD`) are the compound's, months are `YYYY-MM` and quarters `YYYY-Qn`. **Every route here answers `Cache-Control: no-store`.**

## Who does what

- `finance.ledger` (the manager and the accountant by default): every read below.
- `finance.ledger_write` (the same): the settings, a vendor's category, declaring a month, paying a tax, closing a fiscal year.
- `finance.ledger_reopen` (the manager only): reopening a closed fiscal year.

No new permission. Choosing a treasury account to pay from lists the accounts with `finance.treasury`.

## Settings

- `GET /staff/finance/tax/settings` → `TaxSettingsView`: `{ vatRegistered, vatNumber, vatRate, vatSince, taxableKinds, recoverableCategories, withholdingEnabled, withholdingRates: { supplies, services, professional }, withholdingThreshold }`. Defaults: not registered, `14.00`, no taxable kind, no recoverable category, withholding off, `1.00`, `3.00`, `5.00`, threshold `300.00`.
- `PATCH /staff/finance/tax/settings` (every field optional): `vatRegistered`, `vatNumber` (required while registered: `FIELD_REQUIRED`), `vatRate` (above 0 to 100: `INVALID_VALUE {min, max}`), `taxableKinds` (invoice kinds), `recoverableCategories` (budget categories), `withholdingEnabled`, `suppliesRate`, `servicesRate`, `professionalRate` (0 to 100), `withholdingThreshold`. Turning VAT on the first time sets `vatSince` to today. It applies from the next event; nothing is reposted. Audited `tax_settings.updated`.
- The fiscal year's first month is `fiscalYearStartMonth` on `/staff/finance/budget-settings` (ADR 0055); fixed once a budget was submitted or a year was closed (`409 FISCAL_YEAR_LOCKED`).

## VAT on invoices

- `InvoiceView` gains `net`, `vat`, `vatRate` (all `0.00` when untaxed); each line gains `vat` (its `amount` is its net); a credit note gains `vat`, the share it took back. `total` is still what the unit owes (net plus VAT). Payments, balances and the residents' app read `total`.
- A vendor invoice's `VendorInvoiceView` gains `vatRecoverable` (set at its approval, `0.00` when its tax stays part of the cost) and `withholdingCategory`; `POST /staff/finance/vendor-invoices` takes `withholdingCategory?` (`supplies | services | professional | exempt`), else its vendor's.

## The monthly declaration

- `GET /staff/finance/tax/vat/months` → `{ data: [VatMonthView] }`, newest first, from the month VAT began to this one (at most 36): `{ month, status: open | ready | declared, ledgerClosed, taxableSales, outputVat, taxablePurchases, inputVat, carriedIn, netDue, carriedOut, declarationId, declaredAt, declaredBy, paid, open }`. `open` and `ready` months are live from the ledger; a declared month is as declared. Nothing is listed while VAT never began.
- `POST /staff/finance/tax/vat/declarations { month }` → 201 the month. `409 TAX_VAT_NOT_REGISTERED`, `TAX_MONTH_DECLARED {month}`, `TAX_MONTH_OUT_OF_ORDER {next}`, `TAX_MONTH_NOT_CLOSED {month}` (close it on `/staff/finance/gl/periods/close` first). A declared month is not reopened in the ledger (`409 TAX_MONTH_DECLARED` from `periods/reopen`). Audited `vat_declaration.declared`.
- The report `tax_vat` (`groupBy=month|source`) on the reports platform: on screen, PDF, workbook, CSV, compared, scheduled.

## Withholding

- `GET /staff/finance/tax/vendors` (paged, newest first) → `TaxVendorView { id, number, name, taxNumber, categories, withholdingCategory, effectiveCategory, status }`; `PUT /staff/finance/tax/vendors/{id} { withholdingCategory: supplies | services | professional | exempt | null }` (null: by its trades; `404 VENDOR_NOT_FOUND`). Audited `vendor.withholding_category_set`.
- A payout of a vendor invoice, while withholding is on: `payout` gains `withholding`, `withholdingRate`, `withholdingBase`, `withholdingCategory`; `net` is what was paid after it. A payout's `advanceSetOff` is at most gross less retention less withholding (`409 ADVANCE_SET_OFF_EXCEEDED`).
- `GET /staff/finance/tax/withholding/certificates?quarter&vendorId&cursor&limit` (newest first), `…/{id}` → `WithholdingCertificateView { id, number (WHT-), payoutId, payoutNumber, vendorId, vendorName, vendorTaxNumber, category, rate, base, amount, paidOn, quarter, createdAt }`; **`…/{id}/pdf`** the certificate as a PDF attachment for the vendor. `404 WITHHOLDING_CERTIFICATE_NOT_FOUND`. Audited `withholding_certificate.issued` when written.
- `GET /staff/finance/tax/withholding/quarters` → calendar quarters, newest first (at most 16): `{ quarter, startsOn, endsOn, certificates, withheld, paid, open }`. The report `tax_withholding` (`groupBy=vendor|category|month`) is the quarterly report: a period of the quarter's days, by vendor with its name and tax number.

## Taxes paid

- `GET /staff/finance/tax/payments?kind=vat|withholding` (paged, newest first), `POST /staff/finance/tax/payments { kind, declarationId | quarter, amount, paidOn, method: bank_transfer | cheque | cash, cashAccountId, reference? }` → 201 `TaxPaymentView { id, number (TXP-), kind, declarationId, month, quarter, amount, paidOn, method, reference, cashAccountId, paidBy, createdAt }`.
  - VAT needs `declarationId` and refuses `quarter`; withholding needs `quarter` (not ahead) and refuses `declarationId` (`FIELD_REQUIRED`, `FIELD_NOT_ALLOWED`).
  - At most what is still due (`409 TAX_PAYMENT_EXCEEDED {open}`); `404 TAX_DECLARATION_NOT_FOUND`; `paidOn` today or up to 31 days back (`DAY_OUT_OF_RANGE`); the account as a payout takes it (`409 CASH_ACCOUNT_WRONG_KIND {kind}`, `CASH_ACCOUNT_RETIRED`, `CASH_ACCOUNT_INSUFFICIENT {balance}`).
  - It leaves the account as a `tax_payment` movement (`CashMovementView.taxPaymentId`). Audited `tax_payment.recorded`.

## The fiscal years

- `GET /staff/finance/gl/years` → `{ data: [GlYearView] }`, newest first, from the first entry's year: `{ startsOn, endsOn, status: open | closed, closable, openMonths, closeId, revenue, expenses, result, entryId, closedAt, closedBy, reopenings }`. `closable` is true when it is open, every month of it is closed and every earlier year is.
- `POST …/gl/years/close { startsOn }` (`finance.ledger_write`) → 201 the years. `startsOn` is the first of the compound's start month (`400 INVALID_VALUE {startMonth}`). `409 GL_YEAR_MONTHS_OPEN {months}`, `GL_YEAR_PREVIOUS_OPEN {startsOn}`, `GL_YEAR_CLOSED {startsOn}`. Audited `gl_year.closed`.
- `POST …/gl/years/reopen { startsOn, reasonCode }` (`finance.ledger_reopen`, `glPeriodReopen`) → 201 the years: the latest closed year first (`409 GL_YEAR_LATER_CLOSED {startsOn}`), an open year `409 GL_YEAR_NOT_CLOSED`. Its months stay closed. Audited `gl_year.reopened`.
- A month of a closed year is not reopened: `409 GL_YEAR_CLOSED {startsOn}` from `periods/reopen`.
- `GET …/gl/balance-sheet` gains `fiscalYearStartsOn`, `currentYearResult` and `priorYearsResult`; `surplus` is their sum, `equity` holds 3200 accumulated surplus as a line of its own. The income statement of a closed year reads its own revenue and expenses (closing entries are left out).
