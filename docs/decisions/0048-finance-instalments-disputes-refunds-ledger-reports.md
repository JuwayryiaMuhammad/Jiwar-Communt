# 0048 — Finance part 2: instalment plans, invoice disputes, refunds of unit credit, allocation release, a computed ledger and four reports with CSV export

**Status:** Accepted · Phase R6b · Finance (part 2)

## Context

R6a (ADR 0046) gave each unit invoices, credit notes, append-only payments and allocations, unit credit and computed balances. The office still needs to:
- spread a large invoice over time;
- hear a resident who says an invoice is wrong;
- pay back money a unit holds as credit;
- remedy an invoice that was wrong and already paid;
- see the compound's money in one journal;
- close the day and chase what is owed.

Nothing stores a balance. Every new money row is append-only and links to what it changes.

## Decisions

### Permissions

| Permission | Who | What |
|---|---|---|
| `finance.refund` | manager only | refunds of unit credit and their reversal; every refund spends an email-code step-up |
| `finance.reports` | manager, accountant | the ledger and the four reports, and their CSV exports |

Instalment plans and disputes are `finance.invoice`. The accountant gets the reports, never a refund.

### Instalment plans

- **Converting.** `POST /staff/invoices/{id}/instalment-plan` takes 2–24 instalments `{dueOn, amount}`:
  - due days rise, from today to 730 days out;
  - each is at least 1.00;
  - **they add up to exactly what the invoice owes at that moment**, under the unit's finance lock. A payment that lands first answers `INSTALMENTS_DONT_ADD_UP` with the new figure.
- **What one conversion writes:**
  - the plan (`IP-000001`);
  - a credit note of the system reason `instalment_plan`, closing the original;
  - the instalments: ordinary invoices, each from its own one-unit batch (every invoice still comes from a batch). Payments, receipts and reminders work on them unchanged.
- **Refused:** an instalment, an invoice that already has a plan, one owing nothing (`INVOICE_NOT_CONVERTIBLE`), one under an open dispute (`INVOICE_DISPUTED`).
- **The original reads `rescheduled`**, a new computed status: nothing owed, and an `instalment_plan` credit note on it. A partly paid original would otherwise read `paid`.
- **Notices:** one push `instalment_plan.created`. The instalments' issued notices are claimed silently, so they are never announced one by one.
- **Checkouts:** converting supersedes the unit's checkout, as any credit note does. One paid late pays the instalments, oldest due first.
- **Cancelling** (`POST /staff/instalment-plans/{id}/cancel {dueOn}`):
  - credits what the instalments owe (they then read `rescheduled`);
  - asks for it again in one remainder invoice, announced as usual;
  - a plan is cancelled once, its cancellation set together and from null (trigger);
  - its status is computed: `active`, `settled` or `cancelled`.
- **Due-date checks:** `invoices_due` allows 730 days for an instalment, 366 for any other invoice. `invoice_batches_due` allows 730, and the API keeps every other issue within 366.

### Invoice disputes

- **Opening.** Whoever sees a unit's money (`financeView`) disputes one of its invoices that still owes something:
  - `POST /invoices/{id}/disputes` with a reason's code from a closed list, optional words (1–1000) and an optional photo (file purpose `dispute_photo`);
  - one open dispute per invoice (a partial unique index under the unit's lock), three in all;
  - opening supersedes the unit's live checkout.
- **While open, the invoice is frozen:**
  - no due-soon or overdue reminder. Nothing is claimed, so the sweep's rule resumes after the decision;
  - no automatic allocation: credit never pays what the unit contests;
  - no office payment or checkout naming it (`INVOICE_DISPUTED`), and none naming nothing reaches it;
  - no manual credit note, no conversion, no plan cancellation.

  One way in remains: a checkout opened before the dispute and paid late. It lands, since the money was taken.
- **Deciding.** The staff decide once (trigger) with `POST /staff/invoice-disputes/{id}/decide`:
  - accept with a credit note of the system reason `dispute`. It credits up to what credit notes may still take (see *Allocation release*), so a late payment is released to credit;
  - or reject with a reason, `no_longer_owed` among them;
  - held-back credit then pays what is left;
  - the opener alone is told (`invoice.dispute_accepted` / `_rejected`), while they still see the money.
- **At commit:** an accepted dispute has exactly one credit note, on its own invoice, and only such a note names a dispute.
- **Privacy:**
  - the opener's words and photo are shown to the opener and to the staff. The unit's other viewers see the code, the status, the decision and a `mine` flag, never the opener's id;
  - erasing the opener clears the words and photo; the dispute stays and can still be decided;
  - the export carries the account's own disputes with its words, never the photo: once attached it is no longer the account's own file.

### Refunds of unit credit

- **Recording.** `POST /staff/units/{unitId}/refunds` with an amount, a channel, an optional reference and the day (up to 31 days back):
  - channels: cash, bank transfer, or `gateway_manual` for a refund made by hand in the provider's dashboard;
  - no call to Paymob.
- **Step-up:**
  - the tenant step-up (ADR 0036), the platform's mechanism: an email code bound to the session, spent once in the refund's transaction;
  - the account is locked before the session, since deactivation and freeze lock in that order;
  - a replay never reaches it, and a refused refund leaves it usable;
  - reversing a refund needs none: it only returns money.
- **Under the unit's lock:**
  - the amount may not exceed the credit then (`REFUND_EXCEEDS_CREDIT` with the credit);
  - the refund takes its amount from live payments' free money, newest first, as append-only **sources**. Free money is one SQL fragment for the allocator, the credit and the payments' views, so the allocator never pours what was paid back.
- **Reversal** is a new row; the money is credit again and pays what is owed at once.
- **A payment money was refunded from cannot be reversed** (`PAYMENT_REFUNDED`) until the refund is.
- **At commit:** a refund's sources add up to it; a payment's allocations and live refunds never exceed it; a source takes from a live payment of the refund's unit.

### Allocation release

- **The cap.** A staff credit note, and a dispute's acceptance, may take up to what credit notes have not yet taken: the invoice's total less them. Above that the answer is `CREDIT_EXCEEDS_CREDITABLE`, with the creditable amount and what is owed. It replaces R6a's `CREDIT_EXCEEDS_OUTSTANDING`.
- **The release.** The part beyond what is owed releases the invoice's newest live allocations to the unit's credit, splitting the last, as append-only `finance_allocation_releases`; nothing is rewritten.
- **Where released money goes:** it pays the unit's other open invoices at once, or waits as credit to be refunded.
- **Not released:** conversion and cancellation credit exactly what is owed.
- **Counting.** An allocation counts net of its releases everywhere (what an invoice was paid, a payment's free money and views).
- **Reversal:** reversing a payment drops its released money with it.
- **At commit:** an allocation is never released beyond its amount, and a release frees only a live allocation, by a credit note on its own invoice.

### Credit applied

- **Why a column:** the ledger's "credit applied" rows need to know whether an allocation poured money the unit already held. `created_at` cannot tell (Prisma stamps it in the app, per query), and neither can `xmin` (it wraps).
- **The column:** `finance_allocations.from_credit`. The allocator marks every row whose payment is not the one taken in the same call.
- **Before R6b:** rows keep false.

### The ledger

`GET /staff/finance/ledger`:
- reads a period of local days (a year at most), filtered by unit, building and type;
- covers every invoice, credit note, payment, payment reversal, refund, refund reversal, credit applied and allocation release;
- is computed from the append-only rows and never stored.

It is a journal, **not double-entry**: one row per event, from the units' side.
- **Debits:** invoices, payment reversals, refunds.
- **Credits:** credit notes, payments, refund reversals.
- **Neither column:** credit applied and releases, which move money between a unit's credit and an invoice.

Per unit, over all time, debits less credits are what it owes less its credit (a test holds it).

Rows count on the local day they belong to (issued, paid or refunded on; otherwise recorded) and come in order through a (day, recorded, id) cursor.

### Reports

Each report is a fixed number of aggregate queries, in the compound's local days, with a CSV twin:

| Report | What |
|---|---|
| aging | what is owed today by days past due: not yet due, 1–30, 31–60, 61–90, 91+; per unit or building |
| collections | money received in a period by channel and method, per day or month; a payment on its paid day, a reversal on its recorded day |
| outstanding | what each unit or building owes, the overdue part and its credit |
| daily cash | per recorder and method: office payments recorded that day (a backdated one too), their reversals recorded that day, and **cash refunds** recorded that day less those reversed that day; every event in order |

Recorders are named as on R6a's staff views; no resident is.

### CSV

- **Format:**
  - RFC 4180 with CRLF;
  - a UTF-8 byte-order mark, so spreadsheet apps read Arabic;
  - text cells starting with `= + - @` or a tab are defused with an apostrophe; amounts are ours and left alone.
- **The response:**
  - type and filename are carried by the stream, never by `@Header` (Nest sets those before validation, so an error would go out labelled CSV);
  - no-store;
  - `EXPORT_TOO_LARGE` past 100,000 rows.
- **The dashboards' BFF:** it now relays a successful non-JSON body as its bytes (decoding dropped the mark) and forwards `Content-Disposition`.

### Locks and counters

The lock order is ADR 0046's: the caller's account, then (for a refund) the session's step-up, then the unit's finance lock, then the row.

Conversion and cancellation take two counters in one transaction. Counter rows stay locked to commit, and the compound's shared lock does not keep two units apart, so all counters are taken in **one order**: plan, credit note, invoice, refund, receipt. It is checked at runtime: an earlier kind after a later one throws.

### Races designed out, each with a suite

| Race | Suite |
|---|---|
| refund vs credit use (an issue pouring it) and refund vs refund | `refund-vs-credit`, `refunds` |
| dispute acceptance vs a late checkout success | `dispute-vs-payment` |
| conversion vs an office payment or a checkout success | `instalments-vs-payment` |
| release vs refund vs credit use | `release-vs-refund` |
| conversion and cancellation of different units at once | `instalments` |
| a refund vs deactivating its manager | `refunds` |

### Notifications

Category `finance`, none critical, no params:
- `instalment_plan.created` to the unit's money viewers;
- `invoice.dispute_accepted` and `invoice.dispute_rejected` to the opener.

No push on a refund: it shows on the statement.

### Audit

Codes, ids and amounts; never a dispute's words or a refund's reference:
- `instalment_plan.created` / `.cancelled`;
- `invoice_dispute.opened` / `.decided`;
- `refund.recorded` / `.reversed`;
- `credit_note.created` and `invoice_dispute.decided` carry what they `released`.

## Consequences

ADR 0046 is amended on two points:
- **Refunds** come from a unit's credit, released credit included. There is no Paymob refund API call yet: a refund of an online payment is made by hand in Paymob's dashboard and recorded as `gateway_manual`. `PAYMENT_NOT_REVERSIBLE` now says to credit the invoice and refund the credit.
- **The ledger is a journal, not double-entry.**

Other consequences:
- `InvoiceView.status` gains `rescheduled`; `CreditNoteView`, `InvoiceAllocationView` and statement entries gain `released`; `PaymentView` gains `refunded`; statement entries gain `refund` and `refund_reversal`.
- File purpose `dispute_photo`.
- New tables: `instalment_plans`, `invoice_disputes`, `finance_refunds`, `finance_refund_sources`, `finance_allocation_releases`.
- New columns: `invoices.instalment_plan_id` and `instalment_position`; `credit_notes.instalment_plan_id` and `dispute_id`; `finance_allocations.from_credit`.
- G6a (ADR 0047) merged first with its own file purpose, `gate_service_photo`. R6b's migrations (`20261026…`) already sort after G6a's (`20261025…`), and `20261026090300_dispute_photo_purpose` recreates `files_content_type_for_purpose` and `files_size_for_purpose` with both purposes; a schema test checks that both are accepted.
- Not built:
  - refunds through Paymob's API;
  - residents withdrawing a dispute;
  - a running balance in the ledger;
  - historical (as-of) aging;
  - PDFs and late fees;
  - a push on plan cancellation (the remainder's `invoice.issued` tells them);
  - double-entry accounts.
