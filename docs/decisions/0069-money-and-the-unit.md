# 0069 — Money and the unit: a household's own consumption, outages in the brief, what fees pay for and why they change, where the fees go, receipts as PDFs, plans residents ask for, upcoming dues, and field collectors

**Status:** Accepted · R11c-1a · amends ADR 0020 (a capability), 0040 (the brief), 0046 (an office payment's ceiling for a collector), 0048 (plans), 0062 (a compound document kind), 0066 (the resident's side of energy)

## Context

The resident audit (2026-10-21) left R11c with the resident's own unit and its money: consumption (on M1-3a's meters, ADR 0066), upcoming outages, fee transparency, the payment follow-ups (receipts, plans, a forecast, field collection), and the facilities' extras. The product lead split it in three: R11c-1a (this ADR) needs nothing but what is merged; R11c-1b (ADR 0070) waits for M1-3b's facility bans and takes the booking extras and the charges port; R11c-2 (ADR 0071) is the community. G8 holds ADR 0068.

## Decisions

### A household's own consumption

- **Who reads it:** the new capability `consumptionView` — who lives in the unit (a residing occupancy) or an adult member the primary gave `finance`. Never a landlord: a tenant's use shows when their home stands empty (ADR 0066). Not a proxy, a minor, a pending or removed member, or someone who left. No review takes it away.
- **Over what:** the household's own tenure. A unit's meters belong to the unit, never an account, and a household reads them only from the day it came.
  - **`resides_since`** (new, on `unit_occupancies`), kept by a trigger: a residing occupancy's start; a tenant's conversion to owner keeps its tenant row's; now() when `resides` turns true; nothing while it is false (CHECK `resides = (resides_since IS NOT NULL)`). Backfilled per compound.
  - **The tenure starts** at the earliest `resides_since` among the unit's residing occupancies now. A flip of `resides` resets it, so an owner who moves back in after a tenant reads from that day; co-residents are one household.
  - **What counts:** only periods between two readings on or after that day. Nothing is spread back across a move-in: no part of an earlier household's use is read.
- **`GET /units/{unitId}/consumption?kind&from&to`:** by kind and month, with an estimated cost at the compound's tariffs (an estimate, never a bill; billing from meters stays out). A month is `complete` when every meter read in it covers each of its days in the household's time; only complete months are compared — the latest against the month before and the same month a year before.
- **`GET /units/{unitId}/consumption/benchmark?kind&month`:** an ended month against other homes of the same building and kind that lived there all month and were read all month: their median and mean use a square metre a day, and the household's own. **At least five other units**, the household's own left out (ADR 0040's turnout rule, so no figure is ever another unit's own); else `available: false` with `TOO_FEW_UNITS` (or `NO_BUILDING`). Never which units.
- **Spikes:** ADR 0066's spike on a unit's meter also reaches who reads its consumption (`meter.unit_spike`, category `utilities`, the kind and the day only) — when every period its mean was taken over began in the household's time. A household is never compared with the one before it.
- **Saving tips:** a compound document kind `saving_tips` (ADR 0062), a guide never announced.
- **Refused:** a landlord, or a member without `finance`, `403 CONSUMPTION_NOT_ALLOWED`; no place in the unit, `404 UNIT_NOT_FOUND`.

### Outages in the brief

- ADR 0066's outages told to the caller that are under way or start within 48 hours join the daily brief (`outages`), read through maintenance's new port `ResidentOutageSummary`: the kind and the instants.
- **The staff's note** never reaches a resident: `GET /me/outages` drops it (an amendment to ADR 0066, as its notices never carried it).

### What a fee pays for, and why it changed

- **A billing plan's description**, in both languages or neither (`descriptionEn`/`Ar`), audited as changed only.
- **A new amount is kept** in `billing_plan_amount_changes` (immutable): from, to, the first period billed at it (the end of the latest issued, or the plan's start) and, when the board set it, its published decision. The decision is cited only with a new amount and must be published and not archived (`BOARD_PUBLICATION_NOT_FOUND`); finance asks governance through core's `BoardMatters.publishedDecision`, which governance answers (nothing imports governance). The change is decided under the compound's exclusive finance lock, which the billing sweep holds too: a change and a period's issue never cross.
- **`GET /units/{unitId}/fees`** (financeView): each active fee the unit pays — what it pays for, the unit's own amount, its next period, the plan's last 12 changes with their decisions. A plan the unit is excluded from is not its fee.
- **`GET /invoices/{id}/comparison`** (financeView): against the unit's previous invoice of the same kind and plan (an instalment has none), the delta and each line `same`, `added`, `removed` or `changed`. A plan's invoices pair by position (one line each); others by the English text, each once. A plan's changed line says its cause from the records: `plan_amount_changed` (with the decision), `unit_terms`, or `other` (nothing recorded).
- A plan's invoices already carry the plan and the period, so invoice lines need no columns of their own.

### Where the fees go

- **A spending report**, published in one act by `finance.reports`: a snapshot of an approved budget as of the compound's today (a closed year as it closed) — each category's allowance and what was spent, never an expense, a vendor or a name — with up to 20 improvements it paid for, in the staff's words, each may cite the board's published decision; a summary in both languages or neither.
- Three tables, immutable from birth. **One report a budget a day** (a unique key; the loser of a race, `409 SPENDING_REPORT_EXISTS {reportId}`).
- **Readers:** whoever sees some unit's money now — owners, **tenants**, members given `finance` (`GET /finance/spending-reports`, `/{id}`); each is told (`finance.spending_report_published`), outside units a death review pauses.
- No draft: the staff preview the figures in budget-vs-actual (ADR 0055). Improvements cite decisions only: finance may not import engagement, so a done suggestion is described in the staff's words.

### A receipt as a PDF

- `GET /payments/{id}/receipt` (financeView) and `GET /staff/payments/{id}/receipt` (finance.payments), no-store, drawn on demand and never stored: the receipt number, the unit and its building, the amount in one form, the day, the invoices it settled, the method in each language's own sentence, and the public link and code that verify it; a reversed payment says so. **No name** (a receipt is forwarded), never the transfer's or cheque's reference.
- Drawn by the certificate's layout (`certificate.v2`, pinned): the same payment draws the same bytes; no template of its own.

### Plans residents ask for

- **`POST /invoices/{id}/plan-requests {months}`** (financePay): on an invoice it still owes, not an instalment, not split, not disputed; in at most the compound's `planMaxMonths` (6 by default, 2–24). **One waits on an invoice at a time** (a partial unique key; `409 PLAN_REQUEST_PENDING {requestId}`). The finance staff are told.
- **Accepted** (`POST /staff/plan-requests/{id}/accept`) with the instalments the staff set, through `InstalmentsService.convertLocked` — the very split of their own plans (ADR 0048). **Declined** with a `planRequestDecline` reason; **withdrawn** by its requester. Decided once (a trigger, a state-shape CHECK); the requester is told.
- **Lapsed is read, not written:** a waiting request on an invoice paid, credited or split meanwhile reads `lapsed`, whatever paid it, so no payment path needs to know; accepting it then is `INVOICE_NOT_CONVERTIBLE`.
- **The offer:** with an invoice's due-soon notice, one owing at least `planOfferMinAmount` (null: never) is offered a plan once (`invoice.plan_available`, the invoice notice row `plan_offer`). An invoice's detail says `planOffer`.
- **Locks:** the account FOR SHARE, the unit's finance lock, then the request FOR UPDATE; the split reads the balance under that lock.

### Upcoming dues

- **`GET /units/{unitId}/upcoming-dues?months=1..6`** (financeView), computed when asked: what is overdue, then by month what is invoiced and still owed and what the unit's plans will issue it (the periods the billing sweep bills, read ahead, at its own terms), less its credit; never below zero. A forecast, not a promise.
- **The rising notice**, off by default (`duesNotice`): sweep `finance.dues` (every six hours) tells a unit once a month (`finance_dues_notices`, claimed first) when next month asks more than 1.5 times the mean of the six months before, with at least three of them asking anything; instalments aside. The month only.

### Field collectors

- **A role and a permission:** the staff role `collector` holds `finance.collect` alone; the permission sync creates it in existing compounds.
- **Asked** (`POST /units/{unitId}/collector-visits`, financePay): a window of one to four hours, from tomorrow, within 14 days, and the amount expected; **one open a unit**. Assigned by `finance.payments` to an active account holding `finance.collect` (`GET /staff/collectors`).
- **Collected** (`POST /collector/visits/{id}/collected {amount}`, the collector's own visit only): an office cash payment with its receipt and notice, **at most what the unit owes (disputed invoices aside) plus `collectorMargin`** (50.00 by default, 0–1000), so a mistyped figure never makes a large credit — above that, `400 AMOUNT_TOO_HIGH {max}`; beyond the owed is the unit's credit. An office payment at the desk stays at most what is owed (ADR 0046).
- **Failed** with a `collectorVisitFail` reason, optionally offering another window; the resident takes it once as a new visit (`accept-offer`, a unique `follows_id`). Called off by the resident (no reason) or the staff (a `collectorVisitCancel` reason).
- **What the collector sees:** the unit, its building, the window and the amount expected — never a phone, a name or a balance (product decision 3).
- **Locks:** the account FOR SHARE, the unit's finance lock, the visit FOR UPDATE, the payment under that lock. A visit moves forward and closes once.

### Lists, permissions, notices

- **Resident items:** `instalment_plan_request` and `collector_visit` join `GET /me/requests`.
- **Notification kinds:** `meter.unit_spike` (utilities); `finance.spending_report_published`, `finance.dues_rising`, `invoice.plan_available`, `instalment_plan_request.submitted|accepted|declined`, `collector_visit.requested|assigned|cancelled|scheduled|failed` (finance). Params are codes, days and instants; never an amount or a name.
- **Audit:** `spending_report.published`, `plan_request.submitted|withdrawn|accepted|declined`, `collector_visit.requested|assigned|collected|failed|cancelled`, `finance.plan_settings_changed`, `finance.collector_settings_changed`; `billing_plan.updated` gains the effective day and the decision on a new amount. Codes, ids, days, instants and amounts; descriptions and summaries never.

## Consequences

- Six migrations (`20270105090000`…`090600`), each table with RLS FORCE and composite keys; backfills per compound.
- The window of a collector visit is not checked against the management's office hours (finance does not read management).
- The upcoming-dues notice is opt-in; the forecast itself is for every payer.

## Deferred

- **Leak alerts** (use on days a unit stands empty): spike only, as M1-3a decided.
- **Bills from meters.**
- R11c-1b (ADR 0070): companions, the waitlist, overnight stays, the closure's priority rebook, and booking, club and fine charges through a core port.
