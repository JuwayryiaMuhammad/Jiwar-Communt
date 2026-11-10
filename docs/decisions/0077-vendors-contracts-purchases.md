# 0077 — Vendors and compound contracts: a register of the companies the compound buys from, contracts naming one and signed under the board above the manager's limit, renewed once and paid on a schedule, and light purchase requests

**Status:** Accepted · M2-5 · amends ADR 0055 (an expense may name a vendor; a major contract's approval signs one contract or one purchase request), 0064 (an asset's vendor), 0065 (maintenance contracts become the compound's contracts)

## Context

The manager audit (2026-11-01) found no vendor entity: a vendor was free text on a maintenance contract (ADR 0065), an expense (ADR 0055) and an asset (ADR 0064). Partners (ADR 0060) are the services residents use, not the compound's suppliers. Contracts covered only maintenance, with no penalties, renewal or payment terms, and nothing tied a contract to the board's approval or a budget line. Buying what the store lacks had no request at all. The owner approved the manager plan and every audit recommendation (2026-11-01): vendors and partners stay two registers with an optional link; a lapsed paper shows red and blocks nothing; purchasing stays light (a request, no purchase order); a vendor invoice reuses ADR 0055's thresholds. Tenders, bids and contractor accounts are M2-7, which builds on this register.

## Decisions

### Where it lives

- **In maintenance** (`src/maintenance/{vendors,purchases}`, contracts in `src/maintenance/contracts`): maintenance already owns the contracts and the assets, and M2-7's dispatch to a vendor is maintenance's too.
- **Finance names a vendor through core** (`src/core/vendors/vendor-directory.ts`): finance imports no domain (ADR 0046), so maintenance registers one resolver at startup, as the gate registers the works completions' reader (ADR 0063). A missing resolver stops the start.
- **Contracts and purchase requests read the board's approval through core**: `BoardMatters.registerApprovalReader` (governance registers it), returning an approval request's type, status and cost with its row shared.

### Permissions

- `vendors.manage` (manager): the register, its papers, evaluations and suspensions.
- `purchases.request` (manager, security and maintenance supervisors, technician, accountant): ask to buy.
- `purchases.approve` (the manager's by default; a staff kind may hold it, so a deputy can, ADR 0073): decide, fulfil.
- The register is read by who names a vendor: `vendors.manage`, `assets.manage`, `finance.budget`, `purchases.request`, `purchases.approve`. The permission sync brings all three to existing compounds.

### The register

- **A vendor**: a V- number, a name unique in the compound whatever its case, legal name, commercial register and tax numbers, trades (`maintenance`, `cleaning`, `security`, `landscaping`, `pest_control`, `supplies`, `utilities`, `professional`, `other`), a business contact (name, phone, email, address), notes, and an optional partner it is the same company as (one vendor a partner). Its contacts are a company's business data: no personal-data export, but audited as `{ changed }`.
- **Suspended** with a code (`performance`, `documents_lapsed`, `safety`, `fraud`, `other`) and reinstated. A suspended vendor's contracts run on; no new contract, expense or purchase request names it (`VENDOR_SUSPENDED`), by its id or by its name. Never deleted.
- **Papers** (`commercial_register`, `tax_card`, `licence`, `insurance`, `safety_certificate`, `contract_copy`, `other`), a photo or a PDF (file purpose `vendor_document`, 10 MB), with a number and dates; never edited, removed once; at most 50 live. A paper's expiry is announced to `vendors.manage` 30 days ahead, once per date (`maintenance.vendor_documents`, hourly). A lapsed paper shows (`expired`, `documentsExpired`) and blocks nothing.
- **Evaluations**: five scores of 1 to 5 (quality, timeliness, cost, communication, safety) and a note, for one of its contracts or in general; append-only. The vendor shows the last 365 days' averages and how many of its contracts are in force.
- **One writer a name**: an advisory lock on the compound and the lowercased name, then the check, kept by a unique index on `lower(name)`.

### From words to vendors (migration 20270302090200)

- Each compound's distinct names on its contracts, assets and expenses (trimmed, at most 120 characters, compared without case, never empty) become its vendors, numbered in name order, with a phone a contract or an asset gave it. Each row then points at its vendor and keeps its text for display.
- Every contract names a vendor from then on (`vendor_id NOT NULL`); an expense and an asset may name none.
- An asset's warrantor (ADR 0076) stays words: who gives a warranty is often the maker, not a company the compound buys from.
- An expense's vendor link is set once and never moves, a voided expense's too: its trigger is recreated for it.

### Compound contracts (20270302090300)

- **Kinds**: cleaning, security, landscaping, pest control and supply join ADR 0065's. The table keeps its name, `maintenance_contracts`, and its routes.
- **A vendor**: by its id, or a name found in the register (whatever its case) or registered with it.
- **Terms**: a late penalty a day and its cap (a cap needs the daily penalty), the vendor's response hours, penalty terms in words, whether it renews by itself and for how many months (needs the term), the budget line it is paid from.
- **The manager's limit binds contracts**: `major_contract` is always binding (ADR 0073), and its authority is the board's approved major contract itself (the `finance_board_authorizations` of ADR 0073 serve waivers and payment plans). A value above the major contract threshold (ADR 0055) needs the board's approved major contract of at least the value (`CONTRACT_NEEDS_APPROVAL`, `CONTRACT_APPROVAL_INVALID` with `not_approved`, `below_value`, `signs_another`). An approval signs one contract or one purchase request, checked under an advisory lock on the approval (two tables, no unique index across them). Raising a contract's value past its approval is refused.
- **A renewal is a new contract** naming the old (`renews_id`), once (`CONTRACT_ALREADY_RENEWED`): the same vendor, kind, scope, terms, budget line and the assets still in service, from the day after its end by default, its value signed under an approval when above the limit. Never a terminated contract or a suspended vendor's.
- **A payment schedule**: what is due on which day within the contract's dates, one a day, at most 120; replaced whole but for what is paid (`CONTRACT_PAYMENT_PAID`); paid once, on a day not after today, with what paid it. Announced to `assets.manage` a week ahead, once (`maintenance.contract_payments`, hourly; changing the amount announces it again). `GET /maintenance/contract-payments/due` lists the unpaid payments between two days: next month's commitments. Paying through the app is M3-1.
- **Locks**: the contract (update) → the vendor (shared, or the name's lock) → the threshold's row (shared) → the approval request (shared) → the approval's claim lock.

### Purchase requests (20270302090400)

- **Asked for** with a title and description about the work (never a person), an estimated amount, optionally a vendor (a suspended one is refused), the budget line it would be paid from, the stock item it restocks with a quantity, and the day it is needed by (not before today). A PR- number. The approvers are told it waits.
- **Approved** by `purchases.approve` up to the manager's limit; above it only under the board's approved major contract of at least the amount, covering one request or one contract (`PURCHASE_NEEDS_APPROVAL`, `PURCHASE_APPROVAL_INVALID` with `not_approved`, `below_amount`, `covers_another`). Its vendor must not have been suspended since.
- **Nobody approves their own request** (the owner, 2026-11-02): its requester is refused (`PURCHASE_SELF_APPROVAL`). Another holder of `purchases.approve` decides it, a live deputy among them (ADR 0073), or, when the board's approved major contract is named, the board has decided it. Its requester may still call it off.
- **Turned down** with a code (`no_budget`, `not_needed`, `use_stock`, `too_costly`, `other`) and a note; **called off** with a code (`not_needed`, `duplicate`, `vendor_unavailable`, `other`) by its requester or an approver; **fulfilled** once, with what paid it. No purchase order. The requester is told the decision unless they took it.
- A requester sees their own; an approver sees all. A waiting request is in the staff inbox (ADR 0073) for `purchases.approve`, with its amount against the major contract threshold; never approved in bulk, since an approval may name the board's.
- Forward only (a trigger): requested → approved | rejected | cancelled; approved → fulfilled | cancelled.

## Deviations for the owner

1. The register lives in maintenance, and finance reaches it through a core port, rather than a new top-level domain (no new import boundary).
2. The contracts table keeps its name, `maintenance_contracts`, and its `/maintenance/contracts` routes, though it now holds every trade.
3. A contract named by a vendor's name finds the register's vendor or registers one there, inside `assets.manage` (so existing clients keep working). Registering by hand stays `vendors.manage`'s.
4. Two vendors may not share a name in a compound, whatever its case.
5. A purchase request is not checked against its budget line's headroom, and a contract does not reserve its line: commitments that reserve budget are M3-1's.
6. Marking a contract payment paid records a reference, not a link to an expense: paying out through the app is M3-1's.
7. Withdrawn (the owner, 2026-11-02): nobody approves their own purchase request; see above.
8. An asset may name a vendor (`assets.vendor_id`, from the backfill); the asset routes do not take one yet.

## Consequences

- M2-7 points contractor accounts and tenders at `vendors`; M3-1 links vendor invoices, commitments and payouts to the vendors, contracts, payment schedules and purchase requests here.
- The register's papers feed M2-6's compliance calendar later.

## Update (Phase M3-4, ADR 0091)
- Maintenance's payable sources (ADR 0089's bridge) gain two reads without a lock, for the cash flow forecast: the unpaid payments of the contracts not terminated up to a day, and a contract's retention share, end day and termination. The schedule is unchanged.

## Update (Phase M3-6, ADR 0093)
- A vendor carries a withholding category (`supplies`, `services`, `professional`, `exempt`; null: by its trades) beside its tax number, which a withholding certificate prints. It is set with `PUT /staff/finance/tax/vendors/{id}` (`finance.ledger_write`, audited).
