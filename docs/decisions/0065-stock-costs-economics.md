# 0065 — Maintenance operations: the store and its part requests, a ticket's costs and completion, the technician's quotes, maintenance contracts, asset economics, the KPIs and technician performance

**Status:** Accepted · M1-2 · amends ADR 0032 (completion: what was done), 0058 (quotes: a technician suggests, dispatch sends), 0064 (documents: a contract's papers)

## Context

ADR 0064 built the register, plans and inspections. The roles' list also gives the compound manager spare parts and stock, asset economics, the PM KPIs and maintenance contracts, and the technician recording what was done, parts used, an estimated cost for the resident and their own performance. Until now a ticket had no cost but its quote (ADR 0058), only dispatch could quote, a completion said nothing, and no part was tracked.

## Decisions

### The store (`stock.manage`: the maintenance supervisor and the manager)

- **Stores and items:**
  - A store has a code and names, and optionally the common area it is in. A retired store takes no movement; its levels stay readable.
  - An item has a SKU, names and a unit from a closed list. It also has a reorder level, and the average cost of what was received (null before the first receipt). A retired item is neither received nor requested.
- **Levels:** one row per store and item, `0 ≤ reserved ≤ quantity` (a CHECK). A level is made at zero on first use (`ON CONFLICT DO NOTHING`).
- **Movements:** every change of a level is a movement, never edited (a trigger). Each kind carries what it needs, enforced by a CHECK:
  - a receipt: in, at its unit cost, maybe a reference;
  - an adjustment: in or out, with a `stockAdjust` reason;
  - a transfer: a pair of rows under one id;
  - an issue: out, for a part request on a ticket;
  - a return: in, from a ticket.
- **The ledger:** one writer of levels. A change that would leave a level below zero, or below what is reserved, is `409 STOCK_INSUFFICIENT` with what is free.
- **Average cost:** moves on every receipt, over the item's total across stores:
  `(held × average + received × cost) / (held + received)`, to the piastre.
- **The reorder warning:**
  - It goes to every `stock.manage` holder once, as what the stores hold of an item falls to its reorder level.
  - It is stamped on the item and cleared once stock is above the level again, so the next fall warns again.
  - No level, no warning.

### Part requests

- **Asking:** the ticket's technician asks for an item and a quantity while the work is in hand (assigned, on the way, in progress, on hold). Otherwise `409 TICKET_NOT_TAKING_PARTS`.
- **The store's side:**
  - It **reserves** the part in a store, which holds it there and makes it unavailable to anyone else.
  - It **issues** it, which writes the ticket's part cost at the item's average cost then.
  - Or it **declines**, with a `partRequestDecline` reason; the technician is told.
- **Calling off:** the technician calls a request off before it is issued (`partRequestCancel`).
- **Forward only:** a request moves forward once (a trigger). A reservation is let go with a decline or a cancellation.
- **Returns:**
  - The technician returns what they did not use into a store, never more than the ticket got of the item net of returns (`409 PART_RETURN_EXCEEDS_ISSUED`).
  - The return writes a negative part cost at what the item was issued at, on average.
- **A cancelled ticket** calls its open requests off in the same transaction (a cancel hook).
- **The technicians' catalogue** says whether some of an item is free: never how much, never where.

### A ticket's costs (`tickets.dispatch`)

- **Entries:** labour, a contractor and other costs are recorded by dispatch on any ticket. Each has a description, a quantity and a unit amount.
- **Amounts:** an entry's amount is quantity × unit amount, rounded half away from zero (the CHECK computes the same).
- **Voiding:** an entry is voided once with a `ticketCostVoid` reason and never edited (a trigger).
- **Parts:** a part's entry is the store's. It is never voided (`409 TICKET_COST_ENTRY_IS_PART`); a return undoes it.
- **Cap:** 200 entries a ticket, even recorded at once (under the ticket's lock).
- Nothing of a ticket's costs is a resident's to see.

### What was done

- **The record:** completing takes, optionally, what was done from a closed list (`ticketCompletionAction`) and a note. They are recorded with the completion, at its instant, never changed.
- **Who sees what:**
  - The technician and dispatch read the code and the note.
  - The resident reads the code, and only a completion from before they lost `tickets` on the unit.
- A note needs a code.

### The technician's quotes

- **Suggesting:**
  - The ticket's technician suggests a price found on site, where dispatch may quote: a resident's unit ticket before its work starts.
  - One suggestion waits per ticket (a partial unique index backs the check). Dispatch is told.
- **Deciding:**
  - Dispatch **sends** it as the ticket's quote (ADR 0058), as it is or amended, under the same ticket lock, so the residents are asked as for any quote.
  - Or dispatch **dismisses** it with a `quoteSuggestionDismiss` reason; the technician is told.
  - It is decided once.
- Residents never see a suggestion.

### Maintenance contracts (`assets.manage`)

- **The record:** an annual maintenance contract, a service contract or an extended warranty. It has a code, the vendor's name and phone as business data, a scope, start and end dates, a yearly value and notice days.
- **Status:** read from the compound's day (upcoming, active, ended), or terminated.
- **Termination:** once, with a `contractTerminate` reason. A terminated contract never changes (a trigger).
- **Covered assets:** replaced whole, never a retired one (`assetIds.<i>` `ASSET_NOT_AVAILABLE`).
- **Who to call:** an `assets.read` holder sees the active contracts covering an asset (`GET /maintenance/assets/:id/contracts`), without the money.
- **Papers:** a contract's papers are maintenance documents of it, a fourth subject (ADR 0064).
- **The end:** announced to who keeps the register within its notice days, once per end date. A moved end is announced again; a terminated contract never.

### Asset economics and the KPIs (`assets.manage`), computed on read

Nothing is stored to go stale. Everything comes from the tickets, their cost entries (voided ones aside) and the plans' occurrences. *Planned* work is a plan's work order or a resident's check-up; everything else is corrective.

- **An asset:**
  - what it cost ever and in the last twelve months, corrective against planned;
  - its failures (corrective tickets, not cancelled) and their downtime: the days they stood open, times the asset's cost of a day;
  - the mean days between failures since it was commissioned;
  - its age, its life and the year it falls due;
  - a straight-line reserve: a new one's cost over its life a year, and what has built up.
- **Repair or replace, by two rules:**
  - its repairs together reached a new one's cost;
  - or it is past its expected life and a year's repairs reached the compound's share of a new one.

  The share is `replace_cost_share_pct`, a maintenance setting, 50 % by default. Without a replacement cost the advice is `unknown`.
- **The compound over a period:**
  - spend by month, category and kind, planned against corrective;
  - the ten assets that cost most;
  - a five-year capital plan by commissioning year plus life, an overdue replacement counted in the first year;
  - the reserve.
- **The KPIs over a period:**
  - planned against corrective completions;
  - MTTR (opening to completion of corrective work);
  - failures and MTBF (asset-days in service over failures);
  - schedule compliance: occurrences due in the period up to today, skipped ones aside, done on time over due.
- **Periods:** the compound's days, both ends included, real dates, at most 366 days. The thirty days up to today by default.

### Technician performance

- **The figures:** over a period of the compound's days:
  - the completions a technician made;
  - the mean hours from a ticket's opening to them;
  - those the reporter rejected or reopened;
  - the resolution clocks met or breached;
  - the residents' ratings;
  - what is in their hands now.
- **Ratings:** averaged only from three, so none points at the resident who gave it.
- **Who reads them:** a technician their own (`GET /technician/stats`); dispatch everyone's and one's.

## Lock order (new paths)

1. The caller's account (shared).
2. The ticket (`FOR UPDATE`), for whatever hangs off a ticket.
3. The part request, the cost entry or the suggestion.
4. The item (`FOR UPDATE`).
5. Its levels, in store-id order.

A store is shared-locked under a movement. A contract is locked for update, then its assets are shared-locked. The UPDATE grant is on every table these lock.

## Privacy

- **Audit:** codes, ids, quantities, amounts and days only. Names, a cost's description, a note, a vendor's name and phone and a contract's scope are recorded as `{ changed: true }`. A receipt's reference is recorded only as whether it has one.
- **Notifications:** a ticket number, an item's SKU, a contract's code and a day only.
- **Ratings:** never one by one, and never under three.

## Consequences

- **Quotes:** a ticket's quote may now come from a technician's suggestion. The residents see the same quote either way.
- **Documents:** the documents CHECK and their trigger are recreated with the contract subject.
- **Costs:** asset economics and the KPIs read the costs dispatch and the store record. They are as good as what is recorded.
- **Dates:** every day the register, plans, inspections, contracts and these reports take is a day that exists (`@IsLocalDate()`, in the DTO). Until now the pattern let 2026-02-30 through, and an asset's commissioning day and warranty end were stored rolled over to 2 March. The same check now guards ADR 0062's and 0063's days: a unit's contracts (signed, starts, ends), a vault document's expiry, a deposit's receipt, a compound document's effective day, a proxy's end (which answered a 500), a move's planned day and an inspection request's preferred day.

## Open

- Purchasing (requisitions, purchase orders, suppliers) stays the ERP's. A receipt's reference is free text.
- A cost's or a contract's money in the budget (ADR 0055) and in invoices to residents.
- Taking an accepted replacement recommendation (ADR 0064) into the capital plan, and its board approval.
- Counts by store and the store's own audit of a count.
- Technician offline (O2) for part requests and returns.
