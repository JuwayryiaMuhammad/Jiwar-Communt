# 0075 — The board's work: polls weighted by ownership share, candidacy rules, board meetings with their agenda, attendance, minutes and action items, the handover packs and a manager's handover, and the monthly board report

**Status:** Accepted · M2-15 · amends ADR 0051 (weighted polls, candidacy rules, the minutes' meeting), 0055 (a new approval type, `manager_handover_override`; the overview's sections in a monthly report), 0010 (an account is held active by a domain's check), 0062 (one more document drawn on demand)

## Context

The manager's audit (2026-11-01, `manager-gap.md`, part 04) found the board's day-to-day work missing around what ADR 0051, 0055 and 0059 built: no meeting entity (minutes are only an announcement), no follow-up of what a meeting decided, no handover to a new board, no weighted vote, no configurable eligibility, and no monthly report with the compound's logo. The owner approved the plan (`manager-plan.md`, row M2-15) and every recommendation of the audits on 2026-11-01:

- weighted voting optional per poll, by an ownership share the manager enters per unit, off by default; elections stay one unit, one vote;
- the monthly report scheduled, with on-demand regeneration;
- the dues and staff candidacy checks as settings, the rest manual with a reason;
- the handover override decided by the board through ADR 0055, and the platform's deactivation refused with `HANDOVER_PENDING` until then.

## Decisions

### Polls weighted by ownership share

- **`governance_unit_shares`**: a unit's share in %, 0 < share ≤ 100, four decimals. The shares need not add up to 100. The manager writes up to 500 at once (`PUT /staff/governance/unit-shares`, `null` clears one), each change audited with the share it replaced, under the compound's shares lock. The manager and the sitting board read them (`GET`), with the total and how many owned units have none.
- **A poll's `weighting`**: `unit` (the default) or `share`, fixed at creation.
- **Never secret.** A share can be unique to its unit, and a weight beside a secret ballot would name the unit (ADR 0051's box). So `share` with `secret: true` is refused as `FIELD_NOT_ALLOWED`, and a trigger holds it in the database.
- **Taken at the open.** Each elector gets the unit's share then (`governance_electors.weight`; none recorded weighs 0), and the poll keeps the electorate's weight. A share changed afterwards does not reach the poll.
- **Counted at the close.** The turnout's weight and each option's are summed in the database from the electors' weights; the counts are kept beside them.
- **The same rules on the weights.** Quorum and threshold are reckoned on the weights, in whole ten-thousandths, so the arithmetic is exact. An electorate weighing 0 never meets its quorum.
- **Audit.** An unweighted poll's audit metadata is unchanged; a weighted one adds `weighting` and its weights.
- **Elections are never weighted.**

### Candidacy rules

- **`governance_rules`**: one row per compound, written the first time the manager sets a rule. No row reads as the defaults: both checks off, the monthly report on, no logo.
- **Two checks, at nomination**, under the caller's lock. Each refuses with `409 GOVERNANCE_CANDIDACY_NOT_ELIGIBLE` and a `params.reason`:
  - `staff`: the candidate's identity document is also on an active staff or manager account. A candidate with no document recorded passes.
  - `dues_outstanding`: a unit the owner owns owes past its due date on the compound's day. This is finance's answer through core's `BoardMatters` (a new dues reader), using the fragments every balance is read with; an invoice under an open dispute, or rescheduled, does not count.
- **The rest stays the manager's**, by disqualification with a code (ADR 0051). Turning a rule on does not withdraw a candidacy already standing.

### Board meetings

- **`board_meetings`** (`BM-` numbers, from the governance counters):
  - scheduled by a sitting member or the manager, for the board that sits (`BOARD_NOT_SITTING` when none does);
  - regular or extraordinary, with a title, a place, and a time from 30 days back (one recorded after the fact) to a year ahead.
- **Changed while scheduled; then held or cancelled, once** (a trigger). Cancelling takes a `boardMeetingCancel` code. A member acts only on their own board's meetings; once that board stops sitting, its scheduled meetings answer `BOARD_MEETING_BOARD_GONE`.
- **The agenda**: up to 30 items, replaced as a whole while the meeting is scheduled and fixed after (a trigger).
  - Each item is a pending approval request, a pending appeal to the board, an owner's open agenda proposal, or the board's own words. Each subject appears once, and composite keys hold it to the compound.
  - Every read shows each subject's state now.
- **Held, once.** The term and its seats are locked shared (ADR 0055's count lock), then the meeting.
  - Every seat sitting at that moment is recorded, present or not (`board_meeting_attendance`), with the counts.
  - The meeting is **quorate** when more than half the seats were present.
  - A seat ended at the same moment is in the record or not, consistently with the end's time.
- **Minutes.** A board publication of kind `minutes` of the same board, published as ADR 0051 says, is linked to a held meeting once. A publication belongs to one meeting only.
- **Action items** of a held meeting (`board_meeting_actions`):
  - The owner is a sitting member of the meeting's board or an active manager. The item is due from today to a year ahead, on the compound's day.
  - It is done once, by its owner, a sitting member or the manager (with an optional note), or cancelled once by the board with a `boardActionCancel` code.
  - The owner is told when it is given to them, and told once more when it runs past its day (the `governance.board_actions` sweep).
  - A meeting's page lists the open items of the same board's earlier meetings: the decisions still to follow up.
- **The owners never read meetings.** What they read is the minutes. The meeting routes (`/board/meetings`, `/board/meeting-actions`) are for a sitting member or the manager.

### Handovers

- **The board's pack** (`board_handover_packs`) is written once per term, in the transaction that seats the board (an appointment, a certification). It is a snapshot of what the board before left open:
  - pending requests and appeals, and approved requests not yet implemented;
  - decisions with unanswered objections, and open agenda proposals;
  - the board before's open action items, and the latest minutes;
  - the sections the domains register with `BoardMatters` (new: handover sections, read in governance's transaction): maintenance's contracts ending within 90 days, and finance's active budgets, allowance against spend.

  It holds references, codes, days and amounts, never a name. `GET /board/handover-pack` serves it, with its PDF.
- **A manager's handover** (`manager_handovers`):
  - An active manager drafts notes in their own words (`PUT /staff/governance/handover`), then delivers it once with a snapshot of what waits for the office. The sitting board and the other managers are told.
  - The board and the managers read the delivered ones and their PDFs. A draft is its writer's alone.
  - The manager's export holds their notes (`governance/handovers.json`); an erasure clears them once, and the snapshots stay.
- **Held active until handed over.** Core's `AccountLifecycle` gains a deactivation check, which `AccountWriter.setStatus` runs before an active account goes inactive. It applies to every path: the platform's, and a compound's own.
  - While a board sits, a manager who delivered nothing is refused with `409 HANDOVER_PENDING`.
  - The refusal lifts once the board approves a `manager_handover_override` request naming them: a new ADR 0055 approval type whose subject is the manager's account, decided by motions as any other. A raise refuses an account that is not an active manager owing a handover (`MANAGER_HANDOVER_NOT_PENDING`).
  - With no board sitting, nobody could approve it, so nothing blocks.

### The monthly board report

- **`board_reports`**: one row per month and version, each a snapshot that never changes.
  - The `governance.board_reports` sweep writes the month before, once, as version 1, as the system, in every compound that has had a board, and tells the sitting board (`board_report.ready`).
  - A sitting member or the manager draws any month up to the current one again (`POST /board/reports`), as its next version.
- **What it holds:**
  - governance's figures for the month, by the compound's clock: requests raised and decided, appeals lodged and decided, polls closed by result, elections certified, meetings held and quorate, action items done, open and overdue;
  - the overview's sections (ADR 0055: finance's money, security's incidents and violations), each read in its own transaction outside the row's. Totals only.
- **The logo.** A new file purpose, `compound_logo`: a PNG or a JPEG, which a PDF can draw (the content type CHECK takes nothing else: 20270518090615 recreates it after ADR 0087's). The manager sets it in the governance rules, beside the monthly switch. Every one of the board's documents draws it (the report, the handover pack, a manager's handover); a logo that is unreadable or larger than 2 MB is left off, and the document stands without it.
- **One PDF template**, `board-document.v1`, drawn on demand from the stored snapshot (ADR 0062: a PDF is never stored).

### Notifications

Category `governance`; none is critical; no params carry text.

| Kind | To | Params |
|---|---|---|
| `board_meeting.scheduled` | the other sitting members | `kind` |
| `board_meeting.cancelled` | the other sitting members | `reason` |
| `board_meeting_action.assigned` | the owner (not when they wrote it) | — |
| `board_meeting_action.overdue` | the owner, once | — |
| `manager_handover.delivered` | the sitting board, the other managers | — |
| `board_report.ready` | the sitting board | — |

### Lock order

ADR 0051 and 0055's order holds:
1. the caller's account;
2. the accounts a write tells (key-shared);
3. the caller's seat;
4. for a hold, the term and its seats, shared;
5. the meeting, then an action item.

A manager's handover takes the caller's account, then the manager's own advisory lock. A deactivation locks the account's row, then reads the check, so a delivery in flight finishes first.

### Privacy and audit

- **The audit carries ids, codes, counts and days.** A meeting's title and place, and an action's title, appear as `{ changed: true }`. A note is a boolean, and a share is its value.
- **The pack and the report hold no name.**
- **The export** gains `governance/handovers.json` (a manager's own notes).

## Consequences

- **Migrations** `20270216090000`–`20270216090410`, in this order:
  - shares and weighted polls;
  - governance rules;
  - meetings (and the `meeting` counter kind);
  - handovers;
  - the logo's enum value, in a migration of its own;
  - the reports, and the rules' logo and monthly columns;
  - and `20270518090610`: the approval type `manager_handover_override`, its CHECKs (with ADR 0082's `compensation_above_limit`) and a settings row backfilled per compound, dated after ADR 0082's own widening of the same CHECKs.
- **Nine new tenant tables**, each under RLS, forced, with composite keys (`test/rls/board-work-isolation`). Every CHECK is reviewed in the CHECK map.
- **The races are tested** (×5 rounds): two holds at once, a hold against a seat ended, done against cancelled (`meetings-concurrency`).
- **This amends:**
  - ADR 0051: weighted polls, candidacy rules, and a minutes publication's meeting;
  - ADR 0055: the approval type `manager_handover_override`, the handover sections, and the overview reused monthly;
  - ADR 0010: an active account may be held by a domain's deactivation check.
- **The manager dashboard:**
  - The board gains Meetings, Handovers and Monthly reports; the manager reads them too.
  - Governance gains Ownership shares, Board rules and My handover.
  - A request to the board may name the manager who would leave without a handover.

## Deviations (for the owner)

1. **A poll weighted by share is never secret.** The plan said "optional per poll" without a word on secrecy, but a share next to a secret ballot could name its unit.
2. **A unit with no share weighs 0** in a weighted poll, rather than refusing to open it: the open is a sweep's, and must not fail. The view shows how many owned units have no share.
3. **No board sitting, nothing blocks** a manager's deactivation: an override needs a board to decide it.
4. **The staff check matches the identity document only.** Accounts are separate per role (the product's rule), so a document is the one thing that ties two of them to one person; a candidate with none recorded passes.
5. **The board's pack is written only when a board starts to sit from now on.** A board sitting before this phase has none (`BOARD_HANDOVER_PACK_NOT_FOUND`).
6. **Erasing a manager is not held for the handover.** Erasure already refuses an active staff or manager account (ADR 0036), so a manager is deactivated, and therefore handed over, first.
7. **The sweep writes the report only in a compound that has had a board.** A compound that never had one has nobody the report is for; its manager draws any month on demand. This also keeps a run's work to the compounds with a board, since each report reads every domain's sections.

## Open

- A deadline for the monthly report's sweep other than "the month's first run".
- Named owners for an action item outside the board and the managers (a staff member), when the compound wants it.
- The handover pack's sections from management (open requests) and the store, when they register.
