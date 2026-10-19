# 0055 — Board matters: approvals the board decides by motions with a reasoned record, the annual budget and expenses held to it, appeals to the board against staff decisions, and the board's overview

**Status:** Accepted · Phase R7b · Governance and finance

## Context

ADR 0051 gave the owners a board (with a derived `governance.board`), binding polls, elections and the board's announcements. Its Open list left three things:
- budgets and expenses;
- appeals to the board;
- a deadlock between a member's poll opening at once, an owner's erasure and a seat's end.

This ADR adds:
- decision packages the board votes on, with a reasoned record;
- the annual budget, its increases, and expenses held to it and to the manager's limit;
- a second level of appeal against four staff decisions;
- a read-only overview for the board;
- the deadlock fixes.

The model is the one before it:
- rules are checked under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys;
- money is a decimal string.

Out of scope:
- binding the other thresholds;
- paying an expense through the ledger;
- the overview's figures that no report computes yet (Open).

## Decisions

### The registries live in core

Governance must call into finance, gate and facilities (to apply a decision), and they must call into governance (to block a payment while an appeal is pending). Every domain's lint bans importing governance, and gate → governance → engagement → gate would be a CommonJS module cycle.

So core holds **`BoardMatters`** (`src/core/board-matters`, `@Global`), modelled on `DerivedGrants` and `ExportSections`:
- **Approval handlers**, one per type: `subject` (what `subjectId` names), `raise` (validate the subject, lock it, return the cost), `describe` (the subject for the board), `decided`, `withdrawn`.
- **Appeal handlers**, one per kind: `resolve` (the subject's unit, when it was decided, and why it cannot be appealed, if so), `lodged`, `closed`, `describe`.
- **Overview sections** and a **thresholds reader**.

The domains register at startup, and governance checks at bootstrap that every required kind is registered (`missing()`). Governance imports no domain. The types are structural: `BoardNoticeDraft` lives in core, and governance maps it to engagement's `BoardNotices`.

The lint also gains "nothing imports finance" for community, engagement, gate, maintenance and management (proved in `boundaries.spec`).

**Handlers send no notifications and never throw for business state.** A `decided` handler that cannot apply its effect returns `{ implemented: false }`. The matter is still decided and waits for the manager, so no vote is ever stuck. Governance tells everyone; a handler takes no account lock beyond its caller's.

### Approval requests

**Seven types:**
- `annual_budget` (subject: a draft budget; its cost is the budget's total);
- `budget_increase` (subject: a line of the active budget; a cost);
- `major_contract` (a cost);
- `exceptional_fee`;
- `waiver_above_limit`;
- `payment_plan_above_limit`;
- `legal_escalation`.

**`governance_approval_settings`**:
- one row per compound and type, plus `board_appeal`;
- `deadline_days` 1–90 (14 by default; 30 for an annual budget and an appeal);
- a `threshold` for the four thresholded types.

Thresholds are **advisory**: shown with the request, enforcing nothing, except `major_contract`'s, which is the manager's limit for one expense (below). Changing a deadline applies to matters raised afterwards.

**`governance_approval_requests`** (`AR-` numbers):
- the package: context ≤4000, impact ≤2000, cost, up to 5 alternatives (text, cost) and 5 attachments (`approval_attachment`);
- the deadline; the status `pending | approved | rejected | withdrawn`;
- the deciding motion; the withdrawal (by the raiser or a `governance.manage` holder, with an `approvalWithdraw` code);
- the implementation; `overdue_notified_at`.

Triggers keep the package fixed, the status moving forward, and each of decided, withdrawn, implemented and overdue set once. A partial unique allows one pending request per type and subject.

**Implementation.** An approved `annual_budget` or `budget_increase` is implemented by its decision. The manager marks the others implemented, once, with an optional note.

**Permissions.**
- `governance.approvals` (the manager and the accountant): raise and follow the requests.
- `governance.manage`: settings, implementation, and withdrawing anyone's request.

The staff views never return a motion, a vote or a count.

### The board decides by motions

The contest core of ADR 0051 (unit-keyed electors, a secret box, no early close, no chair) does not fit a board of members. A **motion** carries its outcome and its reasons before anyone votes:
- `approve | reject` for a request, `uphold | overturn` for an appeal;
- a rationale of 1–4000 characters, and a note on the alternatives (≤2000, requests only).

**`board_motions`** names exactly one matter, has one open motion per matter (partial uniques), and keeps its terms fixed and its close set once (a trigger).

**`board_votes`**:
- `for | against`, once per member;
- insert-only, and only while the motion is open (an immediate trigger: an auto-close happens in the same transaction).

**The count.**
- n is the motion's term's members seated now, less the recused (below).
- Every unended seat of the term is locked `FOR SHARE` (`lockBoardForVote`), so n holds during the count. Only those members' votes count.
- The quorum q is ⌊n/2⌋+1 votes cast.
- For > against carries, against > for fails. A tie goes the chair's way; with no chair, or a silent chair, it fails.

**Closing.**
- The vote that decides the motion closes it: the outcome is the same whether every remaining seat votes for or against, and the votes cast reach q.
- A member may close it when it is determined, or after the matter's deadline with a quorum (otherwise `BOARD_VOTE_NOT_DUE` / `BOARD_QUORUM_NOT_MET`).
- The proposer may withdraw it while it is open.
- A motion whose term ended or lapsed becomes `lapsed`, by the sweep or when the next motion is proposed (`BOARD_MOTION_LAPSED`).
- A failed, withdrawn or lapsed motion leaves the matter pending for another.

**Carried, in the same transaction:**
- the matter is decided (a deferred trigger: decided exactly when a carried motion with the matching outcome names it);
- the handler applies the effect;
- the result is recorded with `votes_for`, `votes_against` and `sitting`;
- governance tells the raiser or the appellant, the `governance.manage` holders and the board.

An approved annual budget is also published as a board announcement (EN and AR text from finance's handler), authored by the deciding member.

**Overdue.** The `governance.board_matters` sweep sends one `governance_approval.overdue` or `governance_appeal.overdue` notice, to the sitting board and the `governance.manage` holders, for a pending matter past its deadline. The sweep also lapses motions.

**The party rule.** Only the board's views return motions, named votes and counts. The staff and appellants get the outcome and the rationale.

### Recusal on appeals

When an appeal's motion opens, `board_motion_recusals` records a snapshot: every account with an active occupancy of the appeal's unit (owner, landlord or tenant), plus the appellant. The snapshot is insert-only and fixed by a trigger.

- A recused member may not propose, vote on, or close that appeal's motions (`403 BOARD_MEMBER_RECUSED`). Proposing checks the proposer against the occupancies before the snapshot is written.
- Recusal is judged by the snapshot. A member who joins the unit after the motion opened is not recused from it, but is from the next one.
- Recused seats are left out of n and q.
- If the eligible seats are fewer than the board's quorum (⌊seated/2⌋+1), no motion can be proposed (`409 BOARD_QUORUM_UNAVAILABLE`). The appeal stays pending, and the overdue notice reaches the management.

### The annual budget

- `finance_settings.fiscal_year_start_month` (1–12, January by default). It is fixed once a budget was submitted (`FISCAL_YEAR_LOCKED`).
- **`finance_budgets`**:
  - a fiscal year (named after the calendar year it starts in: the one under way, the one before or the next) and its period;
  - the status `draft | submitted | active | rejected | withdrawn`, moving forward only;
  - its request;
  - one active budget, and one draft or submitted budget, per year (partial uniques).
  - A rejected or withdrawn budget is final: a new draft may copy its lines (`copyFromId`). A year with an active budget takes no new draft (`BUDGET_YEAR_ACTIVE`), so an activation never conflicts.
- **`finance_budget_lines`**: one per category (security, cleaning, landscaping, maintenance, utilities, staff, insurance, administration, reserve fund, other), an amount above 0 and a note. They are replaced as a whole, and written or deleted only while the budget is a draft (a trigger).
- **Submitting** raises an `annual_budget` request. A submitted budget is withdrawn only through governance's withdraw, so the matter is always locked before the budget.
- **Approved**, the budget becomes active and is announced to the owners. **Rejected**, it is final.
- **`finance_budget_adjustments`**: an approved `budget_increase` adds its cost to its line (append-only, one per request).

### Expenses

- **`finance_expenses`** (`EX-` numbers):
  - a line of the active budget, a vendor ≤200, an amount, the day it was spent (within the budget's year and not ahead);
  - the invoice, required (`expense_invoice`, the caller's own upload);
  - a reference ≤100, an authorization;
  - terms fixed, voided once with an `expenseVoid` code.
- **Held to the line.** An expense is refused past what its line has left (`EXPENSE_OVER_BUDGET` with `params.remaining`). The remainder is computed after the budget is locked `FOR SHARE` and the line `FOR UPDATE`, so two expenses, an increase or a void never count the same money twice.
- **Held to the manager's limit.** Above `major_contract`'s threshold, an expense must name an authorization (`EXPENSE_NEEDS_APPROVAL` with `params.limit`):
  - an approved major contract grants a `finance_expense_authorizations` row of its cost;
  - the expenses that name it spend it down (`EXPENSE_AUTHORIZATION_EXCEEDED`).
  - The contract itself waits for the manager to mark it implemented.
- **Budget vs actual.** `GET /staff/finance/reports/budget-vs-actual` and its CSV (`finance.reports`). Per line: budgeted, increases, allowance, actual, remaining and % used, with totals last. By default it shows the active budget of the year under way.
- `finance.budget` (the manager and the accountant): settings, budgets, lines, expenses, voids.

### Appeals to the board

An owner of the unit, or its primary, appeals one of four staff decisions within **15 days** of it. There is one appeal per decision, ever (`BOARD_APPEAL_EXISTS`). Grounds are 1–2000 characters, with up to 3 attachments (`board_appeal_attachment`).

| Kind | Appealable when | Overturned |
|---|---|---|
| `vehicle_fine` | its first appeal was upheld, unpaid, not cancelled | cancelled as `board_overturned` |
| `unit_violation` | the same | cancelled as `board_overturned` |
| `booking_suspension` | in force, within 15 days of its start | lifted as `board_overturned` |
| `invoice_dispute` | rejected | follow-up: the management credits the invoice and marks it followed up |

Each subject records when it was appealed and when the appeal closed, each once and in order (a trigger). A refusal says why: `BOARD_APPEAL_NOT_ELIGIBLE` with `params.reason` one of `not_decided | not_against_unit | paid | cancelled | not_in_force | appealed`, or `BOARD_APPEAL_WINDOW_PASSED`.

- **A pending appeal blocks a fine's or violation's payment and its staff cancel** (`FINE_UNDER_APPEAL` / `VIOLATION_UNDER_APPEAL`, `params.level: board`). It blocks neither a suspension's lift (that favours the unit) nor an invoice's payment (the dispute's outcome is a follow-up).
- **The appellant may withdraw** a pending appeal, and then pay.
- **An overturned subject changes silently** in its domain, with a null actor (CHECKs widened). The board's decision notice tells the appellant.
- **The staff never see the deliberation.** The staff view (`governance.manage`) shows where the appeal stands, the outcome, the board's reasons and the follow-up, but no grounds. The residents' views of each subject gain `boardAppealUntil` (null when not appealable) and `boardAppealAt`.
- **The board sees** the unit by its code, the grounds, the attachments, and the subject's codes, amounts and dates, as its domain describes it. It never sees the appellant's or a staff decider's name.

### The board's overview

`GET /board/overview?from&to` (`governance.board`) covers up to 31 days, by default the last 30 local days. It is put together from the sections the domains registered, each from its existing reports, as totals only:
- finance: aging, outstanding and collections, and the active budget's totals;
- security: incidents and violations.

It holds no unit and no name.

### The deadlock fixes (ADR 0051's Open)

Each fix follows ADR 0051's lock order.
- **A member's poll or election opening at once.** The electorate's accounts (every owner's, for nominations) are key-shared before the seat.
- **A certification.** It locks the open term before the contest, closing a contest↔term cycle with a member's cancel.
- **A newcomer.** An account that joins the tell set or the electorate between the plain read and the snapshot is taken with `NOWAIT`. One being erased at that instant answers `409 GOVERNANCE_BUSY`, and nothing is written.
- **`addMember`** takes the open term `FOR UPDATE`, so a seat filled mid-count waits.

`lockLate` tracks the accounts locked per transaction, so every write that tells someone (raise, lodge, withdraw, propose, vote, close) re-reads its recipients after its last row lock.

### Lock order

Each step follows the one before:
1. the caller, `FOR SHARE`;
2. the accounts the write tells, key-shared in id order;
3. the board lock (board writes only);
4. the term and its unended seats, `FOR SHARE`;
5. the matter, then the motion, `FOR UPDATE`;
6. the handler's domain locks:
   - budget, then line;
   - the fine or violation row;
   - the facility unit;
   - the compound shared, the unit, then the dispute;
7. the counters.

Every path that touches a matter and its subject locks the matter first. The one exception is a lodge, which locks the subject and then inserts a new matter. No domain path takes a governance row, so there is no cycle. The vote never takes the board lock.

### Notifications

Category `governance`, none critical. The params are codes only.

| Kind | To | Params |
|---|---|---|
| `governance_approval.raised` | the sitting board | `type` |
| `governance_approval.decided` | the raiser, `governance.manage`, the board | `type`, `decision` |
| `governance_approval.overdue` | the board, `governance.manage` | `type` |
| `governance_approval.implemented` | the board | `type` |
| `governance_approval.withdrawn` | the board | `type` |
| `governance_motion.proposed` | the other sitting members | `matter` |
| `governance_appeal.lodged` | the board | `kind` |
| `governance_appeal.decided` | the appellant, `governance.manage`, the board | `kind`, `outcome` |
| `governance_appeal.overdue` | the board, `governance.manage` | `kind` |

### Privacy and audit

- **Audit** records ids, codes, amounts, counts and outcomes only. Context, impact, alternatives, rationale, the alternatives note, grounds, vendor, reference and notes appear as `{ changed: true }`. A vote's choice never appears: `board_vote.cast` names the motion and the member. `board_motion.closed` records what the count saw (`chair` included).
- **Erasure:**
  - An appellant's grounds and attachments are cleared once (`governance_board_appeal.grounds_cleared`). A pending appeal is still decided, and no notice goes to an inactive account.
  - Votes (by account id), the motions' rationale (the board's official act, written with no names), packages and expense vendors (the compound's records) are kept, their authors shown as erased.
- **Export** (the governance section) gains:
  - `board-appeals.json`: the account's appeals, with the grounds while they last, the outcome and the rationale;
  - `board-votes.json`: its votes and the motions it proposed while seated.

## Consequences

- **Migrations** `20261102090000`–`20261102091000`:
  - three file purposes (`approval_attachment`, `board_appeal_attachment`, `expense_invoice`), and `governance_counters.kind` retyped to TEXT with a CHECK, so contests never take the new kinds;
  - both file CHECKs recreated;
  - settings;
  - requests, alternatives and attachments;
  - motions and votes;
  - budgets, lines and adjustments;
  - authorizations and expenses;
  - appeals, attachments and recusals;
  - the board marks on disputes, fines and violations, and suspensions.
  - Then run `access:sync` (`governance.approvals` and `finance.budget` for the manager and the accountant).
- **Fourteen new tenant tables**, each under RLS, forced, with composite keys. Every CHECK is reviewed in the CHECK map; triggers keep what never changes; nothing is deleted.
- **The races are tested** (×5 rounds, three runs each):
  - two deciding votes, two motions, a vote against a seat ended or filled and against the chair moved, a vote against a withdraw (`board-votes-concurrency`);
  - expenses against a line's remainder, an increase and a void (`expense-concurrency`);
  - a fine's board appeal against its payment, two deciding votes cancelling it once, a deciding vote against the appellant's withdrawal (`vehicles/board-appeal-concurrency`); a violation's appeal against its payment (`security/violation-board-appeals`);
  - a member joining the unit against their vote (`recusal-concurrency`);
  - the three-way poll opening, erasure and seat end (`lock-order`).
- **A fine's first-level decision** is now dated by the database's clock, since the 15 days are measured from it.
- **This amends**:
  - **ADR 0051**: its Open deadlock is closed; `addMember` waits for a count; the export's two files; the counters' kinds.
  - **ADR 0046 and 0048**: the expense counter; a rejected dispute's board appeal and its follow-up; the budget vs actual report beside the others.
  - **ADR 0045**: a fine's board appeal, its payment block and the system's cancel.
  - **ADR 0053**: the same for violations; security's overview section.
  - **ADR 0044**: a suspension appealed and lifted by the board.
- **The manager dashboard:**
  - Governance gains Approvals, Appeals to the board and Board settings.
  - A sitting member gets *The board*: the inbox, each request or appeal with its motions and votes, and the overview. Their derived `governance.board` admits them to the dashboard.
  - Finance gains Budgets and Expenses, and the reports gain Budget vs actual.
- **The owner app's notes** are in [`docs/api/notes/governance.md`](../api/notes/governance.md#appeals-to-the-board).

## Open

- **The overview's other figures**: the collection rate, maintenance tickets against their SLA, and the facilities' use. No report computes them yet.
- **The other thresholds** (exceptional fee, waiver, payment plan) are advisory. Binding them means each domain asking governance before it acts.
- **Expenses are not posted to the ledger** (ADR 0048), and are not paid through the app.
- **An appeal of a dispute** leaves the credit to the management, by hand.
