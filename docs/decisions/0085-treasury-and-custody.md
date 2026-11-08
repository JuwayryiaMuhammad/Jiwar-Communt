# 0085 — Treasury and custody: bank and cash accounts as registers, collectors' and cashiers' custody handed in with its variance and investigation, the cheque register with post-dated cheques, and bank statements imported and matched

**Status:** Accepted · Phase M3-2 · amends ADR 0046 (an office payment by cheque is in the register; office cash is custody), 0048 (a bounced cheque's reversal), 0069 (a collector's cash is custody), 0073 (two inbox types)

## Context

The manager audit (slice 05, 2026-11-01) found finance collecting money with no idea where it went: no bank or cash accounts, a collector's or a cashier's cash never handed in, cheques as a free-text reference, and no statement to check against. The owner chose "export now, ledger later" (decision 1 deferred to M3-5) and accepted C1 as recommended:

> custody = office cash recorded by a collector or cashier and not yet handed in; a hand-in is recorded by a `finance.payments` holder; a variance blocks closing the custody and raises a critical notice.

So this phase builds **registers, not a ledger**: every balance is the sum of append-only movements, and every new money row says where it came from.

## Decisions

### 1. Bank and cash accounts (`finance.treasury`)

- **`finance_cash_accounts`**: a `bank` account (its bank and the **last four digits only**, never the whole number) or a `cash` box; a name unique among live accounts; the day it opened, fixed. Retired once, at a zero balance with no cheque deposited to it pending (`409 CASH_ACCOUNT_NOT_EMPTY {balance, pendingCheques}`); a retired account takes no movement (`CASH_ACCOUNT_RETIRED`).
- **`finance_cash_movements`**, append-only (trigger): a signed amount on a local day and its source, exactly one of:
  - `opening` (the balance an account opened with), `handin` (a custody hand-in's count, into a cash box), `recovery` (a shortage recovered), `cheque` (a cheque cleared, into its bank), `statement_payment` (a bank transfer a statement line showed), `adjustment` (by hand, `cashAdjust` reason), `transfer` (two legs on two accounts adding up to zero, checked at commit), `reversal` (undoes a matched movement exactly, checked at commit), `payout` (a vendor's payout, ADR 0089: its net, out, on its account and day, checked at commit; one per payout).
  - Each source moves money once: a partial unique key per hand-in, recovery, cheque and match.
- **The balance** is read when asked (`SUM`), never stored. A cash box never goes below zero (`409 CASH_ACCOUNT_INSUFFICIENT {balance}`); a bank account may (an overdraft, a fee).
- **Routes:** `GET/POST /staff/finance/cash-accounts`, `GET/PATCH …/{id}`, `POST …/{id}/retire`, `POST …/{id}/adjustments`, `GET /staff/finance/cash-movements`, `POST /staff/finance/cash-transfers`. A movement's day is today or up to 31 days back.
- **Locks:** every writer locks its accounts `FOR UPDATE`, in id order, after any unit, cheque or custody lock it takes: two transfers out of one box meet there and the second sees the first's money gone.

### 2. Custody (C1)

- **What custody is.** A custodian's open custody is the **office cash payments** they recorded since custody began, not reversed and in no hand-in, read from `finance_payments` (one SQL fragment, `OPEN_CUSTODY`), never copied. A collector's cash (ADR 0069) is an office cash payment recorded by the collector, so it is custody with no new path. `finance_settings.custody_from` (the migration's instant for existing compounds) keeps older cash out: it was handed in on paper.
- **The hand-in** (`POST /staff/finance/custody/{accountId}/handins`, `finance.payments`): by anyone **but the custodian** (`403 CUSTODY_CONFLICT`; a CHECK too). It takes **every** open payment at once into a live cash box (`CASH_ACCOUNT_WRONG_KIND` for a bank), against the `expected` the receiver was shown: a payment that landed or was reversed meanwhile answers `409 CUSTODY_CHANGED {expected}` and the receiver counts again; nothing open is `409 CUSTODY_EMPTY`. It records what was `counted`; the counted cash is the box's movement.
  - `finance_custody_handins` (`HI-` numbers, a counter of their own at the end of the counter order): expected, counted, variance = counted − expected (a CHECK), the payment count. `finance_custody_handin_items`: each payment once, ever (the key), each an office cash payment its custodian recorded at its own amount (a trigger), adding up to what was expected (checked at commit).
- **A variance** (any count other than expected) needs its `custodyVariance` reason (and none without), raises the **critical** notice `finance.custody_variance` (params: the hand-in's number) to the `finance.custody` holders but the custodian, and keeps the hand-in `variance` — **closing the custody is blocked** — until it is settled once:
  - by a `finance.custody` holder (the manager by default), with a `custodyOutcome` (`POST /staff/finance/custody-handins/{id}/resolve`); refused while an investigation is open (`CUSTODY_INVESTIGATION_OPEN`);
  - or through **an investigation** (`POST …/{id}/investigation {ownerId, dueOn}`, `finance.custody`): one a hand-in, an owner who holds `finance.custody` or `finance.payments` and is not the custodian, due within 60 days; the owner is told (`finance.custody_investigation_assigned`). Its owner, or a `finance.custody` holder, decides it (`POST /staff/finance/custody-investigations/{id}/decide`), which settles the hand-in.
  - `recovered` is the only outcome that moves money: cash recovered of a **shortage**, never beyond it (`recoveredAmount`, `INVALID_VALUE {max}`), into the hand-in's box. An overage stays in the box; `explained`, `written_off`, `other` move nothing.
  - Nobody settles or decides their own custody.
- **Reads:** `GET /staff/finance/custody` (each custodian's open count, expected, the age of the oldest unhanded payment, unsettled variances), `GET /staff/finance/custody/{accountId}`, `GET /staff/finance/custody-handins[/{id}]`, `GET /staff/finance/custody-investigations` (every one to `finance.custody`, the caller's own to anyone else), and the collector's own, `GET /collector/custody` (`finance.collect`).
- **The staff inbox** (ADR 0073) gains two types, widening both CHECKs:
  - `cash_custody` (`finance.payments`, 24 h): one item a custodian, its id the oldest open payment's and its age from it. A hand-in makes the next payment the item, so the overdue notice is told once per custody, not once per person ever.
  - `custody_variance` (`finance.custody`, 72 h): a hand-in not yet settled.
- **Locks.** A **custody lock** per custodian (a two-key advisory lock). The payment paths take it **before** they insert an office cash payment (`PaymentsService.create`: the office, a collector's visit) or its reversal (`reverseInTx`), after the unit's finance lock they already hold; the hand-in takes it before it reads. So a hand-in sees a payment whole or not at all, and two hand-ins of one custody meet there (the second finds it empty). Settling: the hand-in `FOR UPDATE`, its investigation, then the cash box.

### 3. The cheque register (`finance.payments`)

- **`finance_cheques`**: the unit, the cheque's number (the payment reference's format), its bank, amount, its date (`dueOn`), the day it was received, and where it stands: `received → deposited → cleared | bounced`, or `received → returned`. Terms fixed, the status forward only (trigger); a cheque's payment is a cheque payment of its unit for its amount (trigger), one cheque a payment.
- **Received** (`POST /staff/units/{unitId}/cheques`): dated today or earlier (up to 180 days back, the cheque's life), it **pays at once** as an office payment by cheque did (ADR 0046; at most what is owed, invoices named first); **post-dated** (up to 366 days ahead), it is **held**: no payment, the money does not count yet, but it may not exceed what is owed today; it names no invoice.
  - **An office payment by cheque** (`POST /staff/units/{unitId}/payments`, `method: cheque`) now writes its register row too (its reference as the number, its paid day as its date), so the register holds every cheque from this phase on.
- **Due:** the hourly sweep `finance.cheques` tells `finance.payments` once when a held cheque's day comes (`cheque.due`, the day only; the row claimed first).
- **Deposited** (`…/deposit {accountId}`), into a live bank account, from its date (`409 CHEQUE_NOT_DUE {dueOn}`): a held cheque **pays now**, its payment dated the deposit day; what nothing owes then is the unit's credit (the money is real, as a late checkout's is).
- **Cleared** (`…/clear`): its money in the bank account (a `cheque` movement). **Bounced** (`…/bounce`, `chequeBounce`): its payment reversed through the payments' own path (`bounced_cheque`), so the invoices it paid are owed again and other credit pours as always; the unit's money viewers are told (`cheque.bounced`, no params). A bounce of a cheque whose money was refunded is refused as the reversal is (`PAYMENT_REFUNDED`). **Given back** (`…/return`, `chequeReturn`): only before it was deposited; a payment it made is reversed (`other`).
- **Locks and the race:** every step takes the caller, the cheque's unit finance lock, then the cheque `FOR UPDATE` (then the account). A clear and a bounce at once meet on the unit's lock: the second finds the cheque moved on (`409 CHEQUE_STATE {status}`).

### 4. Bank statements (`finance.treasury`)

- **Two steps, as M2-1's sheets (ADR 0072).** `POST /staff/finance/cash-accounts/{id}/statement-imports {fileId}` (a `data_import` CSV) is the **dry run**: the file parsed whole (`422 STATEMENT_IMPORT_UNREADABLE {problem, line}` when it is not CSV), each row checked — `date` (not ahead, at most two years back), `amount` (signed: money in positive), `reference` ≤100, `description` ≤200 — the problems kept by line, column and code, never a cell; the counts of new lines and of lines imported before. Nothing is imported. `POST /staff/finance/statement-imports/{id}/apply` imports a valid import's new lines, once, within a day (`409 STATEMENT_IMPORT_NOT_VALID {status}`); the expiry sweep lets the rest go.
- **Once per line.** A line's hash binds the account, its day, amount, reference, description and **its place among identical lines of its file**, unique per account: the same file twice imports nothing new, and two identical lines of one file are two lines.
- **Matched on their own** when applied: a line naming **exactly one** target not matched yet — an office **bank transfer** payment by amount, reference (case and spaces aside) and paid day (7 days before the line to one after); a **cheque** deposited to the account by amount and number (deposited up to 14 days before); a **transfer leg** on the account by amount and day (3 days either way).
- **By hand** (`POST /staff/finance/statement-lines/{id}/match {kind, targetId | reasonCode}`): a payment, a cheque, a transfer leg (`GET …/{id}/candidates`: the same amount within 30 days), or an **adjustment** with a `cashAdjust` reason (a bank charge, an interest, a refund paid). The amount must agree and the target be the account's (`409 MATCH_TARGET_INVALID {why}`).
- **What a match moves:** a bank transfer's money into the account (`statement_payment`); an adjustment's (`adjustment`); a deposited cheque is **cleared** by its match. `POST /staff/finance/statement-matches/{id}/undo` undoes a match once, reversing what it moved (a cheque stays cleared).
- **One live match a line and a target** (partial unique keys). Every match of an account — the apply's own included — takes, in order, the targets' units and cheques, then the account `FOR UPDATE`, then checks: two matches of one line answer `409 STATEMENT_LINE_MATCHED {matchId}`, two lines of one target `409 MATCH_TARGET_TAKEN {lineId}`, one import applied twice `STATEMENT_IMPORT_NOT_VALID`.
- **The file** may name payers in its descriptions, so it is kept only while the import may be applied (a CHECK); the lines keep their day, amount, reference and a description of at most 200 characters, the compound's own bank record.

### 5. Permissions, registries, privacy

- **`finance.treasury`** (staff, manager; the manager and the accountant by default) and **`finance.custody`** (manager only; the manager by default): `access:sync` adds them. A deputy never holds them (`finance.*`, ADR 0073).
- **Errors:** `CASH_ACCOUNT_*`, `CUSTODIAN_NOT_FOUND`, `CUSTODY_*`, `CHEQUE_*`, `STATEMENT_*`, `MATCH_TARGET_*`. **Reasons:** `custodyVariance`, `custodyOutcome`, `chequeBounce`, `chequeReturn`, `cashAdjust` (mirrored in `packages/api/src/reasons.ts`).
- **Notifications** (category `finance`, never an amount): `finance.custody_variance` (**critical**, needs a decision), `finance.custody_investigation_assigned` (needs a decision), `cheque.due`, `cheque.bounced`.
- **Audit** (codes, ids, days and amounts; never a cheque's number or a line's words): `cash_account.created|updated|retired`, `cash_transfer.recorded`, `cash_adjustment.recorded`, `custody_handin.recorded|resolved`, `custody_investigation.opened|decided`, `cheque.received|deposited|cleared|bounced|returned`, `statement_import.checked|applied|expired`, `statement_line.matched`, `statement_match.undone`.
- **Privacy.** A hand-in, an investigation and a cheque name staff accounts as a payment's recorder does (ADR 0046): the compound's financial records, kept; an erased account shows no name. Nothing joins the per-account export (staff work records never did) and nothing blocks an erasure. No drawer's name and no bank account number is stored.
- **No new per-request query.** Custody is read only on its own routes and the inbox's sources.

## Deviations for the owner

1. **Money as `DECIMAL(12|14,2)`**, as the repo has it (ADR 0046), not integer minor units: the brief said "integer minor units as the repo does today", and the repo's money is exact two-place decimals everywhere.
2. **"Closing the custody"** is read as the hand-in's own close: a hand-in with a variance stays open until settled, and the inbox and the critical notice keep it in sight. Further hand-ins of the same custodian are not blocked meanwhile (the cash would otherwise stay in a pocket); deactivating an account is not blocked by an open custody or variance (core's path, untouched).
3. **Who settles:** a new manager-only `finance.custody` (a maker-checker over the cashiers), not `finance.payments`. The investigation's owner may also decide it.
4. **Every recorder is a custodian**, the manager included, not only a `collector` or an `accountant` role: whoever recorded office cash holds it.
5. **A post-dated cheque counts when deposited**, not when cleared; a cheque dated today pays at once, as before. A bounce from `cleared` is not modelled (the bank's own late returns are an adjustment).
6. **Cash refunds** (ADR 0048) are not taken out of custody or a cash box yet; a refund paid by transfer is matched on the statement as an adjustment (`refund_paid`), not linked to its refund.
7. **Statement CSV** has one fixed layout (`date, amount, reference, description`); bank-specific layouts and MT940 are later. Statements import into bank accounts only.
8. **The register starts now:** cheques recorded before this phase (as a payment's reference) are not back-filled, and custody starts at the migration.
9. **Payouts leave an account** (ADR 0089, joined at the rebase, `20270610090400`): the method decides the kind (cash from a cash box; a transfer or a cheque from a bank account); a payout set off whole names no account; a payout's movement may reach a vendor invoice's limit (999,999,999.99), past the register's own 10,000,000; its day is the register's window (today or 31 days back). A bank statement's outgoing line is not matched to a payout yet: an outgoing line is matched by hand as an adjustment, as a refund's is.

## Consequences

- Four migrations (`20270610090000`…`090300`, dated after ADR 0089's and 0088's so the stack applies in order), every table RLS FORCE with composite keys; `finance_settings.custody_from`; a partial index on `finance_payments` for custody; the inbox's two CHECKs and the counters' CHECK widened, each with every value before them (main's, ADR 0089's and 0088's). `20270610090400` joins ADR 0089's payouts (the account, the `payout` movement) and, dated after ADR 0089's and ADR 0088's migrations that recreate the counters' and the inbox's CHECKs, recreates both with every value, so a fresh database and an existing one end alike.
- `PaymentsService` takes the custody lock for office cash (create and reversal), writes the register row of an office payment by cheque, and exposes `officeLocked` and `withinOwed` to the register.
- Races designed out, each with a suite: two hand-ins of one custody, a payment and a reversal landing during a hand-in (`treasury/custody`); a clear against a bounce (`treasury/cheques`); two matches of one line, two lines of one payment, one import applied twice (`treasury/statements`); two transfers out of one box (`treasury/accounts`); two payouts out of one box (`payables/payables-concurrency`).
- M3-4 (cash flow and liquidity) reads these balances; M3-5 (the ledger, if built) posts from these movements.

## Deferred

- A statement line matched to a payout, cash refunds out of a box, a bank feed, MT940, bank-specific CSV layouts, a reconciliation report with the statement's own running balance.

## Update (Phase M3-4, ADR 0091)
- The cash flow forecast reads the accounts' balances as its opening position (the live accounts, the sum of their movements). Open custody and the cheques that paid and have not cleared are its first period's money in transit. The realised cash flow report (`cash_flow`) reads the movements, openings and transfers aside.
