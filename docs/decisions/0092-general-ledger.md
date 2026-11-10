# 0092 — The general ledger: double entry beside the computed journal, a standard chart seeded for every compound, every money event posting its balanced entry in its own transaction, manual entries for a second person, months closed in the database, history backfilled, the statements and their exports, and a reconciliation with the registers

**Status:** Accepted · Phase M3-5 · amends ADR 0010 (three permissions), 0046 and 0048 (what their money rows post), 0055 (an expense and its void post), 0073 (an inbox type), 0085 (the treasury posts; "the ledger, if built"), 0086 (four reports), 0089 (the entries the ledger posts from)

## Context

Every money row of the app is append-only and links to what it pays (ADR 0046, 0048, 0055, 0085, 0089), but the books were a computed journal from the units' side only (ADR 0048), and the treasury and payables were registers whose ADRs left the ledger to "M3-5, if built". The owner decided on 2026-11-09:

1. **A real double-entry general ledger**: every entry balances, debits equal to credits, enforced in the database.
2. **A standard chart of accounts seeded for every compound, editable**: the accountant adds sub-accounts and renames; the system accounts the automatic postings use are never removed and never change type. Existing compounds get it too.
3. **Postings automatic, plus manual with approval**: every money event posts its entry in the same transaction as the event; a manual journal entry takes effect only once a second person approves it, never its maker.
4. **A monthly close**: no entry is dated in a closed month (the database refuses it); a correction is a reversing entry in an open month; reopening is the manager's alone, audited.
5. **All history backfilled** at its own days, reconciling with ADR 0085's balances and with the units' receivables, with a test proving it.

Two questions came up while building it, and the owner answered them the same day (both option a):

- **An automatic event dated in a closed month** goes through. Its entry is dated the first day of the next open month and keeps the event's own day in `eventOn`. Refusing the event would have stopped real money: a late webhook, a backdated office payment, a sweep.
- **Manual entries on the control accounts** (each bank and cash account, receivables, unit credit, deposits held, payables, retentions, vendor advances) are refused (`409 GL_ACCOUNT_CONTROLLED`). Corrections there go through the registers' own actions (a treasury adjustment, a credit note, a reversal), so the ledger always agrees with them.

**ADR 0048's computed journal stays as it is** (`GET /staff/finance/ledger`, `finance.reports`): the units' side, one row per event. This ledger lives beside it.

## Decisions

### The chart (`gl_accounts`)

- **The standard chart** (`gl_chart_rows`, codes of four digits, headings that take no line):
  - 1000 Assets: 1100 cash and banks (1110 bank accounts, 1120 cash boxes: each treasury account its own, `1110.01`…); 1200 money in transit (1210 office cash not yet in a cash box, 1220 cheques received not cleared, 1230 bank transfers not yet matched, 1240 online payments not yet settled, 1250 transfers between accounts); 1300 receivables from units; 1400 advances to vendors; 1900 suspense.
  - 2000 Liabilities: 2100 unit credit and advances; 2200 deposits held; 2300 payables to vendors; 2400 retentions held; 2500 refunds paid, not yet matched; 2600 expenses paid outside the treasury.
  - 3000 Equity: 3100 opening balances; 3200 accumulated surplus.
  - 4000 Revenue by charge kind: service charges, maintenance, facility bookings, club memberships, vehicle fines, violation fines, damage claims, other (one per invoice kind, ADR 0046, 0070, 0074), interest, deposits deducted and forfeited.
  - 5000 Expenses by budget category (ADR 0055: security … other), bank charges, cash over and short.
- **Seeded** by `gl_seed_chart`: for a new compound at its creation (finance's provisioning), for the existing ones by the backfill migration, and by the posting functions for a compound that has none yet (a compound written by hand in a test). Idempotent: an account already there keeps the accountant's names.
- **A treasury account opens its own account** (a trigger on `finance_cash_accounts`) under its kind's heading, named as the treasury names it.
- **What changes.** Only the names (a trigger). A code, a type, a place, a key never change. A sub-account (`finance.ledger_write`) takes its parent's type and a code of its parent's plus a dot and up to three digits, once in the chart (`DUPLICATE_RESOURCE`), and never sits under a control account (`GL_ACCOUNT_CONTROLLED`). It is removed only while nothing posted to it and nothing hangs under it (`GL_ACCOUNT_IN_USE`); a system account never is (`GL_ACCOUNT_SYSTEM`, and the trigger).
- **Control accounts** (`control`): the ones a register keeps. They take no manual line and no sub-account (the owner's decision above).

### Entries and lines (`gl_entries`, `gl_lines`)

- **An entry is one event once**: its `source` (21 kinds, a CHECK) and the source row's id are unique, or it is a manual entry's. It has its day (`posted_on`), the event's own day (`event_on`), a reference (the source's number: `INV-`, `RC-`, `JE-`…) and its place in the journal (`seq`, rising with gaps).
- **A line** is a debit or a credit of one postable account (a CHECK), and names a unit (receivables, unit credit, deposits) or a vendor (payables, retentions, advances, an expense) where it concerns one.
- **Balanced in the database.** A constraint trigger at commit refuses an entry with fewer than two lines or debits other than its credits. A line joins its entry in the entry's own transaction only (`txid`), on a postable account (a trigger). Entries and lines are append-only (no update, delete or truncate).

### What posts, and how (accrual basis)

Each money table has a trigger that posts its row's entry in the same transaction, whatever path wrote it: finance's own, the gate's (fines, violations) and the facilities' (the club), which finance may not import (ADR 0015). The rules (`20270615090200`):

| Event | Debit | Credit |
|---|---|---|
| An invoice issued (any kind) | receivables (unit) | its kind's revenue |
| A credit note (any reason) | the invoice kind's revenue | receivables (unit) |
| A payment | where the money is by its method: office cash → 1210, a cheque → 1220, a bank transfer → 1230, a card or wallet → 1240, a deposit's offset → deposits held | unit credit (unit) |
| An allocation (on its payment's day; poured from credit, on its own) | unit credit | receivables |
| An allocation's release | receivables | unit credit |
| A payment reversed | the payment the other way round, and what it still paid (allocations net of releases): receivables | unit credit |
| A refund / its reversal | unit credit | refunds not yet matched (2500) / the other way round |
| A deposit received | where the money is by its method | deposits held (unit) |
| A deposit refunded / deducted / forfeited | deposits held | 2500 / damage claims' revenue (a damage) or deposits retained; a deduction for unpaid dues is its `deposit_offset` payment |
| A manual expense (ADR 0055) / its void | the line's category | expenses paid outside the treasury (2600) / the other way round |
| A vendor's invoice approved / called off after it | the line's category (vendor) | payables / the other way round |
| An invoice's payout | payables (gross) | retentions (held), vendor advances (set off), the account it left (net) |
| An advance paid / a retention released | vendor advances / retentions | the account it left |
| A treasury movement | the account (signed) | by kind: an opening → opening balances; a hand-in → 1210; a recovery → cash over and short; a transfer leg → 1250; a cheque cleared → 1220; a statement's bank transfer → 1230; an adjustment by its reason: a bank charge, interest, a refund paid (2500), a counting correction (cash over and short), other (suspense); a reversal undoes its movement's entry |
| A custody hand-in's variance | cash over and short (short) | 1210 (and the other way when over) |
| The club's own office record, a fine paid at the office before charges, a violation's payment / their reversals | 1210 | the club's, fines' or violations' revenue / the other way round |

- **Not posted.** A payout's expense and its `payout` movement (the payout's entry holds both); a post-dated cheque while held, and a cheque's deposit (its payment posts when it pays; its clearing moves the money); commitments, budget transfers and increases (budget, not money); vendor guarantees (records, not money: ADR 0089); a household's wage to its worker (ADR 0037: the household's money); ticket costs and stock movements (cost records, paid through expenses); a zero amount.
- **The day.** Each entry is dated on its event's day: an invoice's issue, a payment's paid day, a refund's, a deposit's received day, an expense's spent day, a payout's paid day, a movement's day, a hand-in's received day; the rest on the local day they were recorded (a credit note, a reversal, an approval). When that month is closed, the entry is dated the first day of the next open month (`gl_open_on`), keeping its own day in `event_on` (the owner's decision).

### Manual journal entries (`gl_manual_entries`)

- **Written** (`finance.ledger_write`, `JE-` numbers, the counter last in the counters' order): a day of an open month no later than this month's end (`INVALID_VALUE {max}`, `GL_PERIOD_CLOSED {month}`), words (≤ 500), 2–50 lines, each one side of a positive amount below a billion (`INVALID_VALUE {oneOf}`), on postable accounts no register keeps, optionally naming a unit and a line's words (≤ 200); balanced (`400 GL_ENTRY_UNBALANCED {debit, credit}`, and a commit check). It is **pending**: the other holders are told (`gl_manual_entry.submitted`), and it is the inbox type `gl_manual_entry` (`finance.ledger_write`, 72 h, never in bulk).
- **Approved** by a holder **who did not write it** (`409 GL_SELF_APPROVAL`, and a CHECK), while its month is open: it posts its lines as an entry (source `manual`) and its maker is told (`gl_manual_entry.decided`). **Turned down** by another with a `glEntryReject` reason, or **withdrawn** by its maker. Decided once (a trigger), under the months' lock and the entry's row lock.
- **A correction is a reversing entry**: `POST /staff/finance/gl/entries/{id}/reverse {postedOn, memo}` writes a manual entry of a posted manual entry's lines the other way round, pending as any other; one live reversal an entry (`409 GL_ENTRY_REVERSED {manualEntryId}`, a partial unique key); an automatic entry is corrected at its source (`409 GL_ENTRY_NOT_REVERSIBLE {reason: automatic}`), and a reversal is not reversed (`reason: reversal`).

### Months (`gl_periods`)

- **Closed through a month that has ended** (`finance.ledger_write`, `409 GL_PERIOD_NOT_ENDED`): it and every open month before it, from the ledger's first entry's month, in one act (`gl_period.closed` with the months); nothing to close is `409 GL_PERIOD_CLOSED`.
- **The database refuses** an entry dated in a closed month, when it is written and again at commit: a month closed while an event of it was being posted fails that event's transaction, which is retried (the webhook, the sweeps and the client do) and then posts on the next open day.
- **Reopened** by the manager alone (`finance.ledger_reopen`, manager-kind only), one month, with a `glPeriodReopen` reason, audited (`gl_period.reopened`). It may be closed again.
- Closes, reopens and approvals take turns on the compound's months lock (a two-key advisory lock).

### Reads (`finance.ledger`, every response no-store)

- `GET /staff/finance/gl/accounts?asOf` — the chart, each account's own debits and credits up to the day and its balance with its sub-accounts' on its normal side (debit for assets and expenses); `GET …/accounts/{id}?asOf`.
- `GET …/accounts/{id}/ledger?from&to&cursor&limit` — its lines of a period (at most 366 days), oldest first, each with the account's balance after it; `…/ledger/export` its CSV.
- `GET …/trial-balance?asOf`, `GET …/income-statement?from&to`, `GET …/balance-sheet?asOf` (assets, liabilities, equity, and the surplus to date, revenue less expenses not yet closed into equity: there is no year-end entry).
- `GET …/entries?from&to&source&cursor` and `…/entries/{id}`: the journal with its lines; `GET …/journal/export?from&to`: one CSV row a line for an outside accounting system (entry, days, source, reference, the entry's words, account code and name, debit, credit, unit, vendor, the line's words), at most ADR 0048's export limit.
- `GET …/reconciliation`: the ledger against the registers, now, in a fixed number of aggregate queries — each bank and cash account against its movements (ADR 0085), receivables against what the units owe and unit credit against their free money (ADR 0046, 0048's fragments), deposits held, payables (approved and unpaid), retentions and advances — each with its difference, and whether every debit has its credit.
- `GET …/manual-entries?status`, `…/{id}`; `GET …/periods`.
- **The reports platform** (ADR 0086) gains `gl_trial_balance` (by account or type, at the period's end), `gl_income_statement` (by account, type or month), `gl_balance_sheet` (by account or type, with the surplus) and `gl_general_ledger` (every line of the period by account): on screen, PDF, workbook and CSV, compared and scheduled, to `finance.ledger` (now among `REPORT_READERS`). Accounts, months and entries only, never a unit or anybody's words.

### The backfill (`20270615090300`)

- **A migration, not a sweep.** The ledger is whole the moment the code that posts to it runs: no read sees half a history, and no month can be closed over events still to post. It is idempotent (an event posts once, by the entries' unique key), so a failed deploy runs again and picks up where it stopped.
- **Set-based**, for a large compound: per compound, each source's lines are staged by one statement and every staged entry and line written by two, originals first and what undoes them after (mirroring the original's lines). The lines' per-row trigger and the entries' commit check are set aside while it runs, and one query per compound then checks what they would have refused: two lines at least, balanced, postable accounts.
- **The same rules as the triggers.** `test/gl/postings` writes a compound's ledger again with the backfill, twice, and finds the very lines the triggers wrote.

### Permissions, registries, privacy

- **`finance.ledger`** (staff, manager; the manager and the accountant by default) reads; **`finance.ledger_write`** (the same) keeps the chart, writes and approves manual entries and closes months; **`finance.ledger_reopen`** (manager only; the manager) reopens. All `finance.*`: never a deputy's (ADR 0073). `access:sync` adds them.
- **Errors:** `GL_ACCOUNT_*`, `GL_ENTRY_*`, `GL_PERIOD_*`, `GL_MANUAL_ENTRY_*`, `GL_SELF_APPROVAL`. **Reasons:** `glEntryReject`, `glPeriodReopen` (mirrored, each in its CHECK). **Counter:** `journal_entry` (`JE-`).
- **Notifications** (category `finance`, the entry's number only, never an amount): `gl_manual_entry.submitted` (needs a decision), `gl_manual_entry.decided`.
- **Audit:** `gl_account.created|updated|deleted` (codes, parents, types, names: the compound's own), `gl_manual_entry.submitted` (its words as `{ changed }`), `.approved|rejected|withdrawn`, `gl_period.closed|reopened`. An automatic entry is no audit entry of its own: its event is audited where it happens.
- **Privacy.** A line names a unit or a vendor, the compound's own records; a manual entry names its maker and checker as a payment names its recorder (ADR 0046). Nothing joins the per-account export, nothing blocks an erasure. **No new per-request query**: the postings run inside the money transactions only.

## Assumptions (recorded for the owner)

1. **Postings are database triggers** on the money tables, not calls in each service: every path posts, including the gate's and the facilities' that finance may not import, and in the event's own transaction.
2. **Accrual basis**, the owner's default: an invoice is revenue when issued, a payment moves money to the unit's credit, and allocations move that credit onto the invoices. Receivables and unit credit carry a unit on every line, so each unit's balance is theirs (ADR 0048's "owes less its credit").
3. **Money in transit** has its own accounts: office cash until a hand-in (a cash refund and pre-register cash stay there until the accountant clears them), cheques until they clear, office bank transfers until a statement line matches them, online payments until the gateway's settlement is recorded (a statement adjustment, today `other` → suspense). The treasury's accounts hold exactly their registers.
4. **A manual expense was paid outside the treasury** (ADR 0055 records no account): it credits 2600, which the accountant clears.
5. **Office money outside finance's invoices** (the club's own records, fines paid at the office before charges, violations) is revenue when collected; a club record a paid charge wrote is finance's already.
6. **Vendor invoices' tax is part of the cost** (no VAT return yet, ADR 0089 Open).
7. **Guarantees post nothing**: they are a bank's records, not money (ADR 0089 deviation 9).
8. **`finance.ledger_reopen`**, a third permission held by the manager only, is how "the manager's alone" is enforced.
9. **No year-end close**: the balance sheet shows the surplus to date beside equity; a closing entry to accumulated surplus is a manual entry.
10. **A closing race fails the event's transaction**, retried by whoever sent it, rather than a lock every money transaction would take.

## Consequences

- Five migrations (`20270615090000`…`090400`): six tables under RLS, forced, with composite keys; the chart's functions and the treasury account's trigger; the posting functions and fifteen triggers; the backfill; the counters' and the inbox's CHECKs stated last with every value before them.
- Finance's provisioning seeds the chart; `REPORT_KEYS` gains four reports and `REPORT_READERS` `finance.ledger`.
- A test-only superuser write with `session_replication_role = replica` (the suites' time machine) posts nothing: such rows are not in the ledger.

## Open

- A year-end closing entry written by the system; budgets against the ledger's expense accounts.
- The gateway's settlement matched to its online payments; cash refunds out of a cash box (ADR 0085 deviation 6).
- VAT input and output accounts with the tax codes (ADR 0089).
- A per-unit and per-vendor sub-ledger read from the lines' unit and vendor.

## Update (Phase M3-6, ADR 0093)
- The year-end close (assumption 9, "No year-end close") is built: a fiscal year is closed by one entry into accumulated surplus and reopened by the manager; the balance sheet shows the year's result apart from accumulated surplus. Assumption 6 ("vendors' tax is part of the cost") holds only while the compound is not registered for VAT or the category is not recoverable. The chart gains three control accounts (1500 VAT recoverable, 2700 VAT payable, 2800 withholding tax payable); the entries' sources gain `vat_declaration`, `tax_payment`, `year_close` and `year_reopen`. "Open": the year-end entry and the VAT accounts are done.
