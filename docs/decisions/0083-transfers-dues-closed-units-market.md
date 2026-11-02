# 0083 — Transfers, dues and closed units, and the market's completion: ownership transfer requests behind a dues gate, what is owed on the moves, the closed units and their rounds, the management's end of a proxy, documented emergency entries, the market's rules, and a group offer's contract with its re-confirmation

**Status:** Accepted · M2-11 · amends ADR 0021 (an ownership transfer is requested and passes a dues gate), 0050 (a closed-unit inspection task carries out a round), 0062 (the clearance's balance shared), 0063 (the moves show what is owed; the management ends a proxy; closed units' rounds), 0071 (the market's rules; a group offer's contract)

## Context

The manager audit of 2026-11-01 (residents slice, groups M-R5 and M-R6) found:

- **Ownership:** a single instant action (`POST /units/{id}/transfer-ownership`) with no request, no approval step and no dues check at all; the moves showed nothing of what a unit owes.
- **Closed units:** no list of them, and each inspection a task made by hand.
- **Proxies:** the management could read a unit's proxies, never end one.
- **Emergency entry:** nothing recorded a staff entry into a unit.
- **Market:** no commercial block, the categories fixed in code, the limit per account only.
- **Group offers:** no step after confirmation; the price fixed at publication.

The owner approved the plan and every recommendation of the audits (2026-11-01), among them:

- a transfer with dues is blocked by default, with an exceptional approval that needs a reason code and a step-up and is audited;
- one compound setting for the rounds, 30 days by default;
- the manager may revoke an owner's proxy with a reason, and the owner is told;
- "commercial" means services and listings under a shop, with a limit per unit beside the one per account;
- participants re-confirm a final price above the group price, and the others leave.

## Decisions

### Ownership transfer requests (`ownership_transfers`, `OT-`)

- **A request** (`residents.manage`): `POST /staff/units/{unitId}/ownership-transfers` with the buyer (an active resident account), whether they will live there, and the household's end (`householdEnd` and the words the leaving occupants are told, ADR 0021).
  - One waits per unit: checked under the unit's lock, a partial unique index behind it (`OWNERSHIP_TRANSFER_PENDING`, `params.reference`).
  - It waits in the staff inbox (`ownership_transfer`, 72 hours).
- **Approved once** (`…/approve`) or **cancelled once** (`…/cancel`, `ownershipTransferCancel`); a trigger keeps the decision final (`OWNERSHIP_TRANSFER_NOT_PENDING`, `params.status`).
- **The approval** is the dues gate, then the transfer ADR 0021 already does: `ResidentsService.transferOwnershipLocked`, now shared with the direct route.
  - Every active occupancy ends `ownership_transferred` and stays in the unit's history (ADR 0072).
  - The household ends, the buyer's occupancy starts.
  - The audit's `unit.ownership_transferred` gains what was owed, the exception's code and the request.
- **The direct route** `POST /units/{id}/transfer-ownership` passes the same gate (`duesExceptionCode` in its body). The dashboard now requests instead.

### The dues gate

- **The amount is finance's, computed once.** Core's new registry `UnitDues` (as MoveSteps and WorksCompletions): community cannot import finance, so finance registers its one reader at startup, and a missing reader stops the start.
  - The reader is the clearance's own computation (`owedByUnit`, ADR 0062): what every open invoice of the unit still owes, open disputes included. The clearance now calls it too.
- **Under finance's lock.** The gate reads under finance's own lock on the unit (the compound's shared, then the unit's: the one every invoice, payment and credit note takes), held to the transfer's commit. A payment or an invoice landing at that moment is either counted, or waits for the transfer.
- **Blocked by default.** A unit that owes is `409 TRANSFER_DUES_OWED` (`params.owed`).
- **An exception** needs `duesExceptionCode` (`transferDuesException`: settled at the sale, a payment plan agreed, disputed, a court order, other) and a fresh step-up (ADR 0036).
  - The step-up is spent in the transfer's own transaction: a refused or rolled-back transfer leaves it usable.
  - Stored and audited: what was owed, the code, `stepUp: true`.
  - A code given while nothing is owed is ignored, and no step-up is spent.
- **Lock order:** the accounts the transfer touches (the buyer, the unit's occupants and members, ADR 0036), the unit, the request's row, finance's lock last. Two approvals at once: the second waits on the accounts, then finds the request done.
  - The accounts are held `FOR NO KEY UPDATE`, not `FOR UPDATE`: a payment holds finance's lock and then tells the unit's people, whose notices check the accounts' keys (`FOR KEY SHARE`). Under `FOR UPDATE` that payment and an approval reaching for finance's lock deadlocked. An erasure and an account's own share lock still wait for the transfer.

### What is owed on the moves

The moves' board (`GET /staff/moves`) and a move's staff page (`GET /staff/moves/{id}`, now `StaffMoveDetailView`) carry `owed`: what the unit owes now, read through `UnitDues` with no lock. The handover stays unblocked (R8-3).

### Closed units and their rounds (amends ADR 0050, 0063)

- **The list:** `GET /staff/security/closed-units` (`guard_tasks.manage`): every unit in closed mode, the longest closed first (at most 500). For each:
  - its code and building, never who lives there;
  - the last inspection since it closed (when, its outcome);
  - an owner's open or scheduled inspection request;
  - its live proxies, as a count;
  - its live round, and the day the next falls due.
- **A round** (`closed_unit_rounds`) falls due `closedUnitRoundDays` (a gate setting, 7–180, 30 by default) after the later of the day the unit closed and the day it was last inspected, on the compound's calendar.
  - The hourly sweep `security.closed_unit_rounds` makes it due: one live per unit (a partial unique index, `ON CONFLICT DO NOTHING`), never while a closed-unit inspection task is open for the unit.
- **It waits in the staff inbox** (`closed_unit_round`, 72 hours) until the management schedules it: `roundId` on `POST /staff/security/tasks`, a closed-unit inspection of the round's unit, never with `requestId`.
  - Under the round's row lock: two schedulings at once leave one `409 CLOSED_UNIT_ROUND_NOT_DUE`.
- **The task's end settles it.** Done makes the round done; cancelled cancels it (`task_cancelled`), and the sweep makes a new one due. A round's task cancelled another way (its guard left) is settled by the sweep.
- **A reopened unit's due round** is cancelled (`unit_reopened`).
- Rows move forward only (a trigger).

### The management ends a proxy (amends ADR 0063)

- `POST /staff/units/{unitId}/proxies/{id}/revoke` (`residents.manage`) with a code (`proxyRevokeByManagement`: misuse, the owner's request, doubt on identity, a security concern, other).
- It ends as any revoked proxy does (`revoked`, ended by the manager) and keeps the code in a new column `revoke_code`, with its own CHECK; the state shape is not recreated.
- **Who is told:** the proxy's holder (once accepted) and the owner who appointed it (`unit_proxy.revoked_by_management`: the unit's code and the reason's code). This is ADR 0063's first proxy notification.
- `ProxyView.revokeCode` says the management ended it; an owner's revocation has none. The personal-data export's `proxies.json` says so too.

### Emergency entries (`unit_entries`, `UE-`)

Staff went into a unit without its owner, for a danger. It is never silent.

- **Recorded** (`guard_tasks.manage`, `POST /staff/security/unit-entries`) by whoever led it:
  - the unit;
  - the reason's code (`unitEntryReason`: a leak, fire, smoke, gas, an electrical or structural danger, a threat, other);
  - when, within the last seven days;
  - one to three witnesses: other active staff or manager accounts, so two staff at least;
  - up to five photos before, through the files service (`unit_entry_photo`).
- **Told at once,** in the same transaction: every active occupant of the unit (owners and tenants) and its active proxies with `inspections` (`unit_entry.recorded`, **critical**: delivered whatever the preferences say). The audit counts who was told.
- **Reported once** (`…/{id}/report`, the row locked, `UNIT_ENTRY_REPORTED` after):
  - what was found (`unitEntryOutcome`);
  - the staff's words (1–2000);
  - one to five photos after.

  Until then it waits in the staff inbox (`unit_entry_report`, 24 hours). The same people are told (`unit_entry.reported`).
- **The unit's people read its entries** (`GET /units/{unitId}/entries`, no-store, presigned photos): when, why, what was found, the report, the photos and how many witnesses, **never the staff's names**. Anyone else gets `UNIT_NOT_FOUND`. The staff's view names who led it and the witnesses.
- Witnesses and photos never change; an entry is reported once and never deleted (triggers).

### The market's rules (amends ADR 0071)

- **Three more settings** (`PATCH /market/settings`, `market.handle`):
  - `commercialBlocked`;
  - `allowedCategories` (one at least; stored as the categories taken off, `blocked_categories`, so a category added later is allowed until taken off);
  - `maxLivePerUnit` (1–50, 10).
- **Commercial** is a service offered (`kind = service`) or anything under a shop. While blocked:
  - such a listing and a new shop are `409 MARKET_COMMERCIAL_BLOCKED`;
  - so is an edit of one already open.
- **A category taken off** refuses a new listing in it, a new shop in it and an edit that keeps or takes it (`409 MARKET_CATEGORY_NOT_ALLOWED`, `params.category`).
- **What is open stays**, as ADR 0071's settings already behave.
- **Per unit:** a listing counts against the unit it is posted from (the listed unit for a unit's sale), whoever of its people posts it (`409 MARKET_UNIT_LISTING_LIMIT_REACHED`, `params.max`).
  - Counted under a new per-unit quota lock, taken after the account's and before the listed unit's row, so two of a household at the unit's last place leave one refused.
  - The rules are read under the settings' share lock, last.

### A group offer's contract and its re-confirmation (amends ADR 0071)

- **The contract** (`market.handle`, `POST /staff/group-offers/{id}/contract`): a confirmed offer's final price, and the supplier (a partner) when it is named now. Under the offer's lock, once (`GROUP_OFFER_PHASE` after).
- **Everyone joined at the group price:** an offer's terms never change (ADR 0071's trigger).
  - **At or below it:** `contracted` at once, and the participants are told (`group_offer.contracted`, the final price).
  - **Above it:** `reconfirming` for `reconfirmHours` (24–168, 72). Each joined participant is asked (`group_offer.reconfirm_requested`, needs a decision: both prices).
- **While re-confirming,** a participant re-confirms (`POST /market/group-offers/{id}/reconfirm`, once, `GROUP_OFFER_RECONFIRM_NOT_NEEDED` after) or leaves (`…/leave`, now open until the deadline too).
- **At the deadline** the sweep:
  - drops whoever has not re-confirmed (`left_at`, `dropped`; told `group_offer.dropped`);
  - then contracts the offer if enough households remain, or fails it (`failed`, the remaining told).

  Nobody is held to a higher price they did not confirm.
- **A re-confirmation and the close** both take the offer's row and read the database's clock: whichever comes first decides; a re-confirmation after the deadline is refused, and the re-confirmed are never dropped.
- **The view** gains `finalPrice`, `reconfirmClosesAt`, `contractedAt` and `myReconfirmNeeded`; the saving is counted on the final price once there is one. The participant's re-confirmation and drop join the personal-data export.
- The state shape and both forward-only triggers are recreated whole: a re-confirming or contracted offer keeps its joins' `closed_at`.

### Privacy, audit, notifications and the inbox

- **Audit:** `ownership_transfer.*`, `closed_unit_round.*`, `unit_entry.*`, `group_offer.contracted`, `.reconfirm_requested`, `.reconfirmed`.
  - Codes, amounts, counts and days only.
  - Never the household end's words or an entry report's.
  - The buyer by account id.
- **Notifications:** `unit_proxy.revoked_by_management`, `unit_entry.recorded` (on the approved critical list), `unit_entry.reported`, `group_offer.reconfirm_requested`, `group_offer.contracted`, `group_offer.dropped`. Their parameters are a unit's code, codes and prices.
- **The staff inbox** gains `ownership_transfer` (`residents.manage`), `closed_unit_round` and `unit_entry_report` (`guard_tasks.manage`); its type CHECKs are recreated with them.
- **Personal data:**
  - the buyer's transfers (`ownership-transfers.json`: unit, status, dates, what was owed, the codes; never the management's words);
  - a proxy's management code;
  - a participant's re-confirmation and drop.

  An entry's report describes a unit, not a person: kept when its writer is erased, as a found item's description is (ADR 0050).
- **Permissions:** no new permission. Transfers and proxies are `residents.manage`; closed units, rounds and entries `guard_tasks.manage` (the manager and the security supervisor); the market `market.handle`.

## Consequences

**Migrations** (`20270413090000` to `20270413090600`, and `20270518090620`):

| Migration | What it holds |
|---|---|
| `090000` | the enum values, alone: `file_purpose.unit_entry_photo`, `group_offer_status.reconfirming` and `.contracted` |
| `090100` | ownership transfers |
| `090200` | the gate setting `closed_unit_round_days` and closed units' rounds |
| `090300` | the proxy's `revoke_code` |
| `090400` | emergency entries, their witnesses and photos |
| `090500` | the market's three settings and the seller unit's index |
| `090600` | a group offer's contract and its participants' re-confirmation (the shape and both triggers recreated) |
| `20270518090620` | the staff inbox's type CHECKs, with every type: dated after every migration that recreates them, so a fresh database and an existing one both end with all of them |

**Five new tenant tables,** under RLS, forced, composite foreign keys, the UPDATE grant only where a row moves.

**A new core registry,** `UnitDues`. The clearance's balance is shared (`owedByUnit`).

**The manager dashboard gains:**
- "Ownership transfers" (a unit's "Transfer ownership" now requests);
- the moves' owed column;
- a proxy's "End";
- "Closed units" and "Emergency entries";
- the round days in the gate settings;
- the market's three settings;
- an offer's contract.

**migrate-with-data** seeds a confirmed group offer with a participant, and a unit proxy revoked by its owner, which the new columns and recreated triggers carry over.

## Deviations for the owner

1. **A transfer is requested by the management only.** A seller or buyer asks through a management request. The resident app has no transfer form.
2. **The sale contract is not attached to the request.** It goes to the unit's vault or is recorded as an ownership contract (ADR 0062), as today.
3. **The direct route is kept and gated,** rather than retired. It is ADR 0021's contract, and other callers may use it.
4. **"Proxies across units"** (the audit's other half of the row) is not built. The closed units' list counts each unit's proxies.
5. **Emergency entries need no owner's approval first.** The plan's row asks for a documented entry. The audit's owner-approval request, and the override for an immediate danger, are left for later; the owner is told at once and reads the report.
6. **Entries and rounds are `guard_tasks.manage`, not a new permission.** The security supervisor holds it, and the night's emergencies are theirs.
7. **The rounds go to the inbox to be scheduled,** not straight to a guard: the sweep cannot choose a post. A round cancelled with its task falls due again at once.
8. **"Commercial" blocks a new shop too,** and an edit of a commercial listing already open: the switch's sense, applied to every new or edited thing.
9. **The categories are stored as those taken off,** shown as those allowed: a category added to the market later is allowed until taken off.
10. **"Two joins at the per-unit limit"** is read as two listings by two people of one household at the unit's last place. Group offers have no per-unit limit.
11. **A group offer's re-confirmation is asked of every joined participant** when the final price is above the group price, since all joined at it. A participant may leave until the deadline. The handlers cannot shorten it.
12. **Fulfilment, ratings and complaints per group offer** (the audit's next row) and the partners' documents and commissions (M-R6's other rows) are not in this phase's plan row: left for later.
