# 0046 — Finance: a unit's invoices, recurring billing and credit notes, payments at the office and online through each compound's own Paymob account, allocation as append-only rows, and receipts anyone can verify

**Status:** Accepted · Phase R6a · Finance (invoices and payments)

## Context

Compounds bill their units (service charge, maintenance, other) and collect at the office on paper. R6a adds:
- invoices per unit, recurring billing plans, credit notes;
- online payment by card or mobile wallet, through each compound's own Paymob merchant account (hosted checkout only: no card data here);
- payments recorded at the office;
- a receipt for every payment, verifiable on a public page;
- the manager and admin screens to run it.

R6b's double-entry ledger must be able to post from these records, so every money row is append-only and links to what it pays.

Out of scope: instalments, disputes, refunds (online payments included), the ledger, reports, PDFs, late fees, vehicle fines as invoices (they stay office-paid, ADR 0045).

The design reuses the reviewed parts of another project of ours (Jiwar-Hub: the Paymob client, the credential vault, the webhook's order of operations, the gateway transaction claim, the receipt code), copied and adapted, and fixes what that review found (below).

## Decisions

### A domain of its own

`src/finance`, reading community through `CommunityFinancePort` (capabilities, who to tell, which units an issue reaches) and nothing else; nothing imports it.

### Who sees and pays: the capabilities as they are

Finance never re-derives who may do what: it reads `capabilitiesFor`.
- **Sees** a unit's invoices, payments, receipts and statement: `financeView` — every active occupancy (owners, landlords **and tenants**), and members the primary gave `finance`. Not a minor, a pending member or an ended occupancy; nobody under a death review.
- **Pays online:** `financePay`, and a member within its cap per operation on the whole basket (`FINANCE_CAP_EXCEEDED`).
- Tenants keep both, as the capabilities had them since ADR 0020: decided with the product owner (service charges are often paid by tenants), and it keeps one source of truth.
- Residents need `units.read`; there is no resident permission for money.

### Permissions

| Permission | Who | What |
|---|---|---|
| `finance.gateway` | manager only | the compound's Paymob account, online payment on or off, Paymob's callbacks |
| `finance.billing` | manager, accountant | billing plans and their per-unit terms |
| `finance.invoice` | manager, accountant | invoices, credit notes, unit statements |
| `finance.payments` | manager, accountant | office payments and their reversal, every payment, unit statements |

A cashier-type role may hold `finance.payments` alone. The accountant (ADR 0044, 0045) now keeps the club, the fines' payments and the units' billing, invoices and payments; never the gateway.

### The gateway: each compound's own account, sealed

- `finance_gateways`: one row per compound. Every credential (secret key, public key, HMAC secret, card and wallet integration ids) is sealed with **AES-256-GCM**, a fresh 12-byte IV, and additional data `jiwar:finance:<compound>:<field>:v<keyVersion>`: a value copied to another compound or column, or relabelled with another version, does not open. Only the last four characters are stored in the clear and ever shown.
- The key: `PAYMENT_CREDENTIALS_KEY` (base64 of 32 bytes), its `_KEY_VERSION`, and `_PREVIOUS_KEYS` (retired keys, decrypt only). Rotation: new key and version, old key to the previous list, deploy, `node dist/finance/gateway/reencrypt.cli.js` (idempotent), drop the old key.
- **Boot rule:** when any compound takes online payment (credentials set, switched on, not switched off by the platform), the app refuses to start without `PAYMENT_CREDENTIALS_KEY`, without `PAYMENT_WEBHOOK_BASE_URL`, or without the key of any such gateway's version; the message names variables and compound ids. With nothing enabled it boots, and saving credentials answers `PAYMENT_VAULT_UNAVAILABLE` (503).
- **Who changes it:** the manager (`PUT`/`PATCH /staff/finance/gateway`) and the platform (`PUT`/`PATCH /platform/tenants/{id}/payment-gateway`), both after a step-up; the platform also switches online payment off for the compound, which wins over the manager's switch. A live key is refused in sandbox mode and the reverse.
- **Platform step-up:** the tenant step-up (ADR 0036) for the platform owner: `POST /platform/step-up` emails a code to the admin, bound to the platform session; `/verify` opens one action for ten minutes (`platform_sessions.step_up_until`). It sits under `/platform/` because the admin app's BFF does not forward `platform/auth`. The password being the platform's only login factor, the code adds a second.
- Audit: the fields that changed and the mode, never a value, not even the last four characters.

### Invoices: immutable, corrected by credit notes, owed is computed

- An **issue** is a batch: one unit, a building's units (by `units.building`), or every unit (at most 3000); one invoice per unit, each its own gapless number (`INV-000123`) from a per-compound counter taken in the transaction. 1–20 lines in English and Arabic; total at most 1,000,000 EGP; due from today to 366 days ahead (the compound's day). `Idempotency-Key` replays the batch.
- Invoices, lines, batches and credit notes are append-only (triggers refuse even their owner). At commit the database checks that lines add up to the total and that credit notes and live payments never exceed it.
- A **credit note** takes at most what is still owed off one invoice, with a reason code only (`billing_error`, `waiver`, `duplicate`, `goodwill`, `other`). A paid amount is not credited: it would be refunded (R6b).
- **Owed and status are computed**, never stored, by one SQL fragment every read and decision uses: owed = total − credit notes − live allocations; status `credited`, `paid`, `overdue` (after the due date), `partially_paid` or `unpaid`. No late fee.

### Recurring billing

- A plan bills **every unit** a fixed amount each period (monthly, quarterly, annual), from the first of a month; a unit may have another amount or be left out. Kind, frequency and start are fixed (trigger); names, amount and days apply to periods issued afterwards.
- The sweep bills the period that holds today (a unit added since, or a plan created during it, is billed for it) and the next one within its lead days; nothing earlier is caught up. It runs under the compound's **exclusive** finance lock, so it alone decides which units are missing; a unique index keeps one invoice per (plan, unit, period).

### Payments, allocation and credit

- `finance_payments` is append-only: a payment (channel, method, amount, local day, receipt number `RC-000123` and a 22-character random code) or the reversal of an office payment (reason `entered_in_error`, `duplicate`, `bounced_cheque`, `other`; a trigger refuses any other reversal).
- **Allocations** are append-only rows: which invoice a payment paid. An allocation stops counting when its payment is reversed; nothing is ever rewritten (no mutable "paid amount").
- **Order:** a payment pays the invoices it names first (a checkout's, or those the office picked), then the oldest due. Money nothing owed absorbs is the unit's **credit**, applied at once to its next invoices; a reversal frees invoices that other credit then pays.
- **At the office** (`finance.payments`): cash, a bank transfer or a cheque (a reference for the last two only), paid today or up to 31 days back, **never more than is owed** — of the invoices named, or of all the unit's (`PAYMENT_EXCEEDS_OUTSTANDING`). `Idempotency-Key` records once.

### Locks

Every money event takes, in order: the caller's account row (shared); the compound's finance lock — shared for an event on one unit, exclusive for an issue to many units (one lock however many); then each unit's finance lock. They are **two-key advisory locks**, never the units' rows: community writes lock a unit row and then reach for accounts, so a unit row lock taken after an account here would cycle with them (as ADR 0044 found).

### Online: checkouts and the webhook

- **A checkout** (`POST /units/{unitId}/payment-sessions`) pays some or all of what a unit owes. One live checkout per unit (a partial unique index): the same basket by the same payer reuses it; one being opened answers `PAYMENT_SESSION_IN_FLIGHT`; anything else supersedes it. Paymob is asked outside any transaction (both integrations, an item per invoice, **placeholder billing data** — no name, email or phone leaves the compound — our notification and return URLs, an expiration). The client secret is stored sealed by the vault (bound to the compound and the checkout) and the checkout URL rebuilt on demand, never stored. A credit note or an office payment supersedes the unit's open checkout. A minute sweep expires checkouts.
- **The return page** (`<PUBLIC_APP_URL>/paid`) proves nothing; the app polls `GET /payment-sessions/{id}`.
- **The webhook** `POST /api/v1/public/payments/paymob/{compoundId}`, the only thing that makes a payment:
  1. a per-IP limiter fed by failures only;
  2. the compound from the URL and its gateway; then the **HMAC-SHA512** over Paymob's twenty ordered fields, compared with `crypto.timingSafeEqual`. Every refusal so far is the same 401;
  3. the checkout by our reference, then **Paymob's signed `order.id` must equal the one the checkout holds**: our reference is not signed, so this stops a signed success of one checkout being replayed onto another;
  4. pending and failed attempts are logged (the payer may retry on the same page); amount and currency must match exactly;
  5. **verification with Paymob is mandatory**: the intention, read by its sealed client secret, must be paid with the same amount, currency, reference and order. A contradiction applies nothing; no answer yet is 500 (Paymob retries) and a sweep retries for 48 hours;
  6. the settlement under the unit's finance lock: Paymob's transaction id is **claimed once per compound** (a unique index; a replayed or concurrent delivery is a no-op), the payment written and allocated, the checkout succeeds — also after it expired or was superseded (the money was taken), the excess becoming credit. A second, different transaction on a paid checkout is recorded as credit and flagged.
  Every callback past the HMAC is logged (`payment_gateway_events`, signed scalars only) and the manager reads it (`GET /staff/finance/gateway-events`). A compound switched off by the platform still lands what was already paid.
- Tests never reach Paymob: the client sends through an injectable transport, and every test harness puts a fake in its place.

### What was fixed from the reused code

1. Verification with Paymob is mandatory (it was optional and off), and the signed order id binds a callback to its checkout.
2. The HMAC comparison is `crypto.timingSafeEqual` (it was a hand-written loop with an early exit).
3. The client secret is sealed, never stored in plain text or inside a stored URL.
4. Ciphertexts carry a key version, and the ring rotates.
5. Office payments are idempotent.
6. Audit holds codes, ids and amounts only.

### Receipts

Every payment has a receipt: a number and 128 random bits as a 22-character code. `receipt_links` (global, like `visitor_pass_links`) maps the code's SHA-256 to the compound. The public page (`apps/public` `/receipt#<code>`, `POST /public/receipts/lookup`) refuses a malformed code before any read and answers only the compound, the number, the amount, the day and `valid` or `reversed` — never a name, a unit or a reference.

### Notifications

Category `finance`, none critical, **no params** (never an amount, a number, a unit or a name), to every account that sees the unit's money: `invoice.issued` (a batch of up to 50 at once, a bigger one by the minute sweep, each once), `invoice.due_soon` (three days before), `invoice.overdue` (the day after), `payment.received`. Each invoice notice is claimed once by its row.

### Privacy

- The export's `finance` section: per unit whose money the account sees, its statement, invoices and payments (no recorder); the checkouts it opened (no secret).
- Nothing is deleted. Invoices belong to units; payments point at their payer or recorder, a tombstone once erased: no deletion blocker. An account that is deactivated, frozen, erased or leaves its unit stops its open checkouts.
- Audit actions: `finance_gateway.set`/`.toggled`, `tenant.payment_gateway_set`/`_toggled`, `invoice_batch.issued`, `credit_note.created`, `billing_plan.*`, `payment.recorded` (office and online alike, the channel in its metadata; the webhook's actor is the system), `payment.reversed`, `payment_session.opened`. Security events: `platform.step_up_*`, `payment.webhook_rejected`, `.order_mismatch`, `.amount_mismatch`, `.verification_contradicted`, `.duplicate_charge`.

### Deployment

- The webhook needs a public HTTPS address. On staging the API has none, so `community.escanestate.com`'s server block gains one location for the webhook prefix only, ahead of the public app; `PAYMENT_WEBHOOK_BASE_URL=https://community.escanestate.com` (deploy/README.md). The public app's own proxy never forwards it (a test pins it).
- New env: `PAYMENT_CREDENTIALS_KEY`, `_KEY_VERSION`, `_PREVIOUS_KEYS`, `PAYMENT_WEBHOOK_BASE_URL`, `PAYMOB_BASE_URL`, `PAYMOB_REQUEST_TIMEOUT_MS`, `PAYMENT_SESSION_TTL_MINUTES`, `RECEIPT_PAGE_RATE_LIMIT_PER_IP`.

## Consequences

- ADR 0020: tenants' `financeView`/`financePay` are now used as written.
- ADR 0036: step-up gains a platform twin; the export gains a section and the preferences a category.
- ADR 0044 and 0045: the accountant role widens (above).
- R6b posts its ledger from `finance_payments` (and their reversals), `finance_allocations`, `invoices` and `credit_notes`; refunds of online payments and of credit come with it.
- Paymob's `intention_order_id` on creation and the intention lookup's response shape are taken from Paymob's documentation and the reused project's captured fixtures; a sandbox run should confirm them before going live.
