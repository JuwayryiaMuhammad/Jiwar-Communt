# 0088 — The contractor portal and tenders: a contractor account tied to a vendor that works its vendor's tickets as a technician does, tenders with sealed bids opened by two people and an award that signs the contract, and a contractor's invoices

**Status:** Accepted · Phase M2-7 · amends ADR 0002 (a sixth capacity, `contractor`), 0010 (its role and kind), 0032/0033 (a ticket offered to a vendor, an assignment of type `vendor`), 0073 (`tender_opening` in the inbox; `tenders.open` never a deputy's), 0077 (contracts signed by an award), 0089 (the `contractor` channel)

## Context

The manager audit (slice 01, 2026-11-01) found no way to give a ticket to an outside vendor, and the plan (row M2-7) asked for a contractor portal and tenders on top of M2-5's vendor register. The owner decided (2026-11-01): **contractors get a contractor account type tied to a vendor company, using the technician app's flows; plus a time-limited link for bids from vendors not yet registered.** M3-1 (ADR 0089) gave its vendors' invoices a `channel` for this portal's intake.

## Decisions

### A contractor account

- **Its own kind**, `contractor` (the sixth capacity, ADR 0002), tied to **one vendor** of the register (`accounts.vendor_id`): only a contractor has one (CHECK `accounts_contractor_vendor`), and it never changes (a trigger) — another vendor's work is another account (same email or phone: one login, two capacities).
- **Invited by the manager** on the vendor's page (`POST /staff/vendors/{id}/contractors`, `vendors.manage`) as staff are (the account and its login identifiers together, ADR 0003); a suspended vendor takes none. It signs in as staff do (OTP). Deactivated through `PATCH /accounts/{id}/status`.
- **The `contractor` role** (kind default) holds `tickets.contract_work`, `tenders.bid`, `vendor_invoices.submit` — permissions of the contractor kind only. The catalog keeps every staff and resident permission from its kind (`PERMISSION_NOT_ASSIGNABLE`), so no role edit can widen what a contractor reads.
- **Its vendor** is read from its own row, locked shared, on its routes only: **no query is added to any request**.
- **Personal data**: its export (`contractor/`) carries its vendor, the offers it decided, the tickets it worked (numbers, categories, when), its bids (an amount only once opened) and the invoices it sent in. An active contractor blocks its erasure (`active_staff_role`) until deactivated; its deactivation releases its tickets (ADR 0033's handler).

### Dispatch to a vendor (20270608090100)

- Dispatch (`tickets.dispatch`) **offers a queued ticket with no technician** to a vendor that has a contractor who can take it (`POST /maintenance/tickets/{id}/vendor-dispatch {vendorId, note?}`). The ticket stays `new`, **out of the engine's and the sweep's reach** (ADR 0033), its **SLA clock unchanged** (ADR 0034). A dispatcher's assignment is refused while it is offered (`TICKET_OFFERED_TO_VENDOR`; a trigger refuses it too).
- The vendor's contractors are told and see the offer (`GET /contractor/dispatches`): its number, category, priority, place kind, a common area's label and the dispatcher's note — **never the unit, a resident or the ticket's words**.
- **Taken** (`POST /contractor/dispatches/{id}/accept`): the contractor becomes the ticket's technician (`assigned`, an assignment of type `vendor`) and works it through **the technician's own routes** — the ticket and its thread, visits, checklist, safety and permits, quote suggestions, SOS — now open to `tickets.contract_work` as well as `tickets.work`. What it reads there is exactly what a technician on that job reads. The routes no contractor needs (availability, stats, stock, inspections, meters, fault reports) stay staff's.
- **Turned down** with a reason (`vendorDispatchDecline`), or **taken back** by dispatch (`vendorDispatchWithdraw`): the queue's again, and the engine tries it.
- **Every path by which the contractor later loses the ticket** — gives it back, a reassignment, a release, a rejection sent back to the queue — lets the vendor go too, and a cancel ends an open offer: a trigger on `tickets` keeps `vendor_id` and closes the offer (`returned`, `withdrawn` by the system). No path can forget.
- **Qualified while it holds `tickets.contract_work`**: the qualification backstop (ADR 0033) counts an active contractor with it as able to hold its tickets.
- One live offer a ticket (a partial unique key); forward only (a trigger). Locks: the caller → the vendor (shared) → the ticket (update): two contractors taking one offer, or a contractor and dispatch, are one after the other.

### Tenders (20270608090200)

- **A draft** (`staff/tenders`, `tenders.manage`, TN- numbers): title, scope, trade, the contract kind its award signs, a budget line, the management's estimate, a deadline; documents (`tender_document`, 20 live) and invitations while a draft or taking bids. **Published**, it takes bids until its deadline (an hour to a year ahead), which may only move later before it passes; its terms are then fixed (a trigger).
- **Invited**: a registered vendor, not suspended, once (its contractors are told and bid from `contractor/tenders`); or a company that is not registered, with **a bid link**: a 32-byte token of this tender alone, kept as a labelled SHA-256 in a global pointer (`tender_bid_links`, as ADR 0060's desk links), shown once, living 90 days at most, rate-limited per IP (30/min) and per link (20/min), revoked with its invitation or replaced (`…/invitations/{id}/link`). Every link that opens nothing — malformed, unknown, revoked, replaced, expired, its invitation revoked, its tender a draft or called off, a suspended compound's — is one 404 (`TENDER_LINK_NOT_FOUND`), and it opens nothing but its tender and its own bid (`public/tender-bids`, the token in a POST body).
- **Sealed by the database**: a bid's amount is written into `tender_bids.sealed_amount`, a column the app's role may insert but never select (column privileges); `amount` stays NULL until the opening, when a trigger copies it, and only then. **Nobody reads an amount before the opening** — the manager, the bidder and anyone with the app's database role included; the audit and the notices carry none. Staff see who bid and when, nothing of the terms or the offer. One live bid an invitation; withdrawn while bids are taken, never edited.
- **The deadline**: a bid is taken while the tender is open and before its deadline **by the database's clock read after the tender's row is shared-locked**; the opening takes that row for update. A bid at the deadline is late (`TENDER_CLOSED`); one just before it is in the opening.
- **Opened by two people** (`POST /staff/tenders/{id}/opening`, `tenders.open`): after the deadline the first call begins it and the other holders are asked (`tender_opening` in the staff inbox, 48 h); a second, different person confirms it, and every live bid is unsealed at that moment. Whoever began it never confirms it (`TENDER_OPENING_SAME_PERSON`; a CHECK keeps the two apart), and `tenders.open` is **never delegated** (ADR 0073), so nobody confirms in the first one's place. Both are recorded. The manager and the accountant hold it by default.
- **Awarded** to one opened bid (`POST …/award {bidId, code, startsOn, endsOn, approvalRequestId?}`): the compound's contract (ADR 0077) is signed with its vendor, at the bid's amount, the tender's kind and line, **in the same transaction, through the contracts' own `createIn`** — a link bidder is found in the register by its name or registered. Above the manager's limit it needs the board's approved `major_contract` (ADR 0055, binding, ADR 0073) of at least the amount, which then signs this contract and no other (ADR 0077's claim lock): **no second approval**. Bidders' contractors are told how it ended.
- **Called off** with a code (`tenderCancel`) any time before the award; its links are revoked.
- Locks: the caller → the tender (update; shared by a bid) → an invitation (update; shared by a bid) → the bid → the vendor (shared, or the name's lock) → the threshold → the approval → its claim lock → the counters.

### A contractor's invoices (amends ADR 0089)

- `POST /contractor/invoices` (`vendor_invoices.submit`): into the vendors' invoices by the **`contractor` channel** (the shape CHECK widened), against its own vendor's contract (or a line of its schedule) or a purchase it fulfilled — anyone else's is the same 404 as an unknown one — never naming a vendor or a line, with its own `expense_invoice` scan and lines. A trigger checks the recorder is a contractor of that very vendor, and that the office's channel never is. Then **M3-1's path unchanged**: the number once, approved by another against the line, paid once into its expense; the contractor is told the decision as any recorder.
- `GET /contractor/invoices` (its vendor's, by this channel: what was sent and where it stands, never the office's notes or approver) and `GET /contractor/contracts` (its vendor's contracts and schedules).

### Registries

- **Permissions**: `tickets.contract_work`, `tenders.bid`, `vendor_invoices.submit` (contractor); `tenders.manage` (manager), `tenders.open` (manager, accountant). `access:sync` brings them and the `contractor` role to existing compounds.
- **Errors**: `VENDOR_DISPATCH_*`, `TICKET_OFFERED_TO_VENDOR`, `TENDER_*`. **Reasons**: `vendorDispatchDecline`, `vendorDispatchWithdraw`, `tenderCancel` (mirrored, each in its CHECK).
- **Notifications** (references and codes; never an amount, never a resident): `vendor_dispatch.offered` (needs a decision), `.decided`, `.withdrawn`; `tender.invited` (needs a decision), `.opening_started` (needs a decision), `.opened`, `.decided`.
- **Audit**: `vendor_dispatch.*`, `tender.*`, `tender_invitation.*` (a link opened by the system), `tender_bid.submitted|withdrawn` (ids and instants only); the award with its amount.
- **Files**: `tender_document`, `tender_bid` (the content type CHECK recreated whole); ticket and checklist photos and the invoice scan take the contractor's permissions as uploaders.

## Deviations for the owner

1. **A contractor works the ticket it took as its technician**, through the technician's routes; the vendor's other contractors see the offer, not each other's tickets. The vendor's own SLA (`responseHours` on its contract) is not a second clock: the ticket's own SLA runs (as the plan says, "same SLA clock").
2. **The offer shows no unit, resident or ticket words** before it is taken; the dispatcher's note says what the vendor needs. An offer has no expiry: an unanswered one is the SLA's breach to flag.
3. **A rejected or reopened ticket a contractor did goes back to the queue** (the first-rejection return to its technician, ADR 0032, is staff's), and its vendor lets go; dispatch may offer it again.
4. **A link bid carries the amount, the duration and a note, no document**: an upload without an account through the link is left for later (a registered vendor's contractor attaches its offer).
5. **The award needs the board's approval raised beforehand** through governance (`major_contract`, the bid's amount), then named at the award; the award does not raise it itself. That one approval signs the contract.
6. **A link bidder is registered at the award** by its company name (found whatever its case, or created), as a contract naming a vendor by name is (ADR 0077); its papers come after.
7. **Who bid and when are visible to staff before the opening** (the envelopes received); their amounts, terms and offers are not.
8. **The opening has no lapse**: a begun opening waits for its second person; a call-off ends it.
9. **The bid link's page is the public app's** (`/b#<token>`), not built here; the API is.

## Consequences

- Three migrations (`20270608090000`…`090200`); five tenant tables under RLS, forced, with composite keys; a global pointer table; every CHECK on the review list, every unique index mapped; triggers on `accounts`, `tickets`, `tenders`, `tender_bids`, `tender_invitations`, `tender_documents`, `ticket_vendor_dispatches`, `finance_vendor_invoices`; the files', the procurement counters', the inbox's and the invoices' CHECKs recreated whole.
- `MaintenanceContractsService.createIn` signs a contract in a caller's transaction (the award), with the same checks and locks as `create`.
- Races designed out, each with its test: two contractors taking one offer; a contractor and dispatch; two openings at once (and one person twice); bids around the deadline and the opening; two awards; a link used as it is revoked.

## Open

- The public bid page (apps/public) and the contractor's mobile screens.
- Documents through a bid link; purchase orders from an award (ADR 0089 Open).
