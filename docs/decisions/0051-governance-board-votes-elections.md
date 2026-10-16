# 0051 — Governance: the owners' board with terms and offices, binding polls with a quorum and a threshold, a secret ballot no query can tie to its unit, elections that seat the next board, and the board's decisions as announcements

**Status:** Accepted · Phase R7a · Governance

## Context

The owners of a compound run their association through a board: it sits for a term, puts questions to the owners, and is replaced by an election. Until now the app had only consultative polls (ADR 0040), which allow a vote to change, have no quorum, and are put to an audience rather than to a fixed electorate. ADR 0040 said that formal votes are R7 and would not reuse its tables.

Out of scope here: budgets and expenses, and appeals to the board (R7b).

The model follows the domains before it:
- rules are checked under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### A domain of its own

`src/governance`:
- It reads the community through `CommunityGovernancePort`: who owns which unit, by the capability flags `governanceVote` and `governanceCandidacy`, names and unit codes.
- It reads engagement through its index for one thing: `BoardNotices`, which writes the board's announcements (below).
- Nothing imports governance. This amends ADR 0040's "nothing imports engagement": governance may, through the index.

### Who owns, and whose hand casts a unit's vote

An owner is an active account with an active owner occupancy of a unit, landlords included. Tenants and household members are not owners; they find nothing (`GOVERNANCE_NOT_AVAILABLE`, 404).

The data had no "primary owner": `is_primary` is the primary *occupant*, who must live there, may be a tenant, and is never a landlord, and a unit may have several owners. So each unit has a **voting owner**:
- the primary occupant, when they own the unit;
- otherwise the unit's longest-standing active owner (earliest start, then id).

A unit with no active owner account has no voice and is left out of the electorate and of the quorum. If co-owners need to choose among themselves, a designation chosen by the owners or the manager can come later (a new column on `unit_occupancies`); nothing here depends on how the voting owner is found.

**The electorate is a snapshot.** It is taken when a contest opens (`governance_electors`, one row per unit with its voting owner then) and is fixed by a trigger. An elector who sells the unit or stops owning it while the vote is open keeps that unit's vote, and still reads the contest. One owner of several units votes once per unit.

### The board

**`board_terms`**
- `source` is `appointed` or `elected` (with its election), with seats 3–15, a start and a planned end.
- At most one term per compound is open (a partial unique index), so two boards never overlap.
- A term is current until its end, then **lapsed**: its members hold nothing until a board is appointed or certified.
- It ends once: `succeeded` (an election's board took over) or `replaced` (the manager appointed one after it lapsed).

**`board_members`**
- An owner's seat with a role: one chair, one secretary and one treasurer at most (a partial unique index), and members, within the seats.
- The role may change while seated; the seat ends once, with a code: `resigned | removed | misconduct | other` by the manager, or `no_longer_owner | account_closed` by the system.

**Writes.**
- The manager appoints only when no board sits (`BOARD_SITTING`).
- The manager fills a vacant seat, records the offices the board chose, and ends a seat.
- Every board write takes the compound's board lock first.

### A seat's permissions are derived, not granted

An account has one role for life (ADR 0010), and a seat comes and goes with a term. So `governance.board` is a **derived permission** (amends ADR 0010):
- `PERMISSIONS` lists it with `derived: true` and no kinds.
- No role may hold it: the roles API refuses it, `access:sync` gives it to nobody, a grant made in the database never counts, and the catalog listing leaves it out.
- Core's `DerivedGrants` takes one check per derived permission from the domain that owns the fact; governance registers "the account sits on the current board".
- `PermissionsGuard` and `PermissionsService.has` ask it on every request that the role does not settle, and never cache the answer. A term that ends or lapses, or a seat that is ended, stops working on the very next request.
- An action taken with it checks the seat again inside its transaction, locked shared: ending the seat waits for it, or the action sees the seat gone.
- `GET /me` lists the derived permissions the account holds with its role's.

**The other permissions.**
- `governance.read` (the resident role): the owners read and vote.
- `governance.manage` (the manager): the board register, appointments, disqualifications, certifications, and anything the board does.

### The voting core

Polls and elections share one machinery.

**`governance_contests`**
- `kind` and `secret` are fixed (an election is always secret), with the choices a ballot takes, a window, and the open (with the electorate's size), the close (with the turnout) or the cancel, each once.
- Its window may change only until it opens. Sweeps open (`governance.open`) and close (`governance.close`) each contest once, one per transaction, `SKIP LOCKED`.

**`governance_participations`**
- One row per unit (the primary key), written by its elector while the contest is open (a trigger), never changed.
- It says who voted for the unit and when. On an **open** contest it also holds the choice.

**The secret ballot is secret against the database.** Nothing stored ties a secret ballot to its unit:
- **Never next to the unit.** A participation's composite key `(contest, secret)` and a CHECK make it impossible to store a choice next to a unit on a secret contest.
- **One box row while voting is open.** The ballots live in **one row per contest** (`governance_ballot_boxes.ballots`): a JSON object from a random v4 id to the choice, rewritten whole by every vote. A row per ballot would leak: its `xmin` would be the transaction that wrote its participation and its audit entry, and its `ctid` would give the order of voting.
- **No order in the box.** JSON object keys are stored sorted, and the ids are random v4, never the schema's time-ordered v7.
- **No ballot ever changes.** A trigger lets a ballot into the box while the contest is open, and never lets one change or go.
- **At the close, rows with nothing to tie them.** The ballots become rows (`governance_ballots`: a v4 id, the contest, the choice; no unit, no account, no time, no serial), written in one statement in id order, and the box is deleted. Every ballot row has the close's `xmin`, and their physical order is their random ids'.
- **Every count agrees.** A deferred trigger holds, at every commit, one ballot per participation of a secret contest: in its box while open, in its rows once closed, none once cancelled.
- **Nothing elsewhere holds a choice.**
  - The vote's route is `@Idempotent({ bodyless: true })`: the stored hash leaves the body out, and the answer it stores is `{ unitId, votedAt }`.
  - A refused choice is named by its field only.
  - The audit's `governance.vote_cast` holds the contest and the unit.
  - Notifications hold no choice.
- **No count while open.** Nobody sees a count while a contest is open, the staff included, so a vote's effect cannot be watched; the turnout shows.
- **No vote changes.** On an open contest no vote changes either: one rule for both.

What this does not protect against, stated plainly:
- someone who reads the database **continuously** and diffs the box after each vote;
- a superuser reading dead tuples or the WAL with page-level tools;
- statement logging that records parameters (`log_statement = all`), an operations setting to keep off.

These need live or physical access to the server, not a copy of its data.

### Polls

- A title and a body in English, Arabic or both.
- **Kinds:** `yes_no` (the options yes, no and abstain) or `choice` (2–10 options in the poll's languages, one picked).
- **Settings:** a quorum (1–100 % of the electorate's units), a pass threshold (50–100 %), and secret or open, fixed at creation. Until it opens anything else may change; then only a cancel, with a code (`governancePollCancel`).
- **The result**, once, at the close:
  - Quorum: `turnout × 100 ≥ quorum × electorate`. Abstentions count towards it, and an empty electorate never meets it.
  - `yes_no` passes when `yes × 100 ≥ threshold × (yes + no)` and yes beats no (a tie fails).
  - `choice`: the strictly first option with `threshold` of the votes wins; a tie at the top is `tied`.
- An **open** poll's roll call (unit code → choice) is shown to the owners, the board and the manager once it closes. Views carry `rollCallPublic` so the app can say so before anyone votes.

### How these polls differ from the community polls (ADR 0040)

The two kinds share nothing: their own tables, services and routes (`/polls` and `/community/polls` there, `/governance/polls` and `/staff/governance/polls` here). An owner can see both, so the difference is spelled out:

| | Community polls (ADR 0040) | Governance polls (this ADR) |
|---|---|---|
| What the result is | Consultative: advice to management, with counts and no outcome | Binding: `passed`, `failed`, `no_quorum` or `tied`, recorded once at the close |
| Who puts it | The staff (`community.publish`) | The sitting board or the manager |
| Who is asked | An audience (everyone, owners or tenants, by building), evaluated at read time | The owners only: a snapshot of the units taken when it opens |
| Who casts a unit's vote | The primary occupant or a member given `polls_vote`; on an owners' poll, any active owner | The unit's voting owner, fixed in the snapshot |
| Votes | One per unit, changeable until the close | One per unit, never changed |
| Quorum and threshold | None | A quorum (1–100 % of the electorate) and a pass threshold (50–100 %) |
| Choices | Single or multiple | Yes, no or abstain; or exactly one of 2–10 options |
| Secrecy | Always secret; the unit's voters see its current choice while open | Secret or open, fixed at creation; an open poll's roll call is shown after the close |
| Counts while open | Shown once five units have voted | Never; turnout only |

### Elections

- **Calling one.** The board (or the manager) calls one: its seats (3–15, fixed), the winners' term (6–60 months), a nomination window (24 hours to 30 days) and a voting window (within 14 days of the nominations' close).
- **Nominations.** Owners are told once when nominations open. An owner stands once with an optional statement (≤ 500 characters) and may withdraw while nominations are open. The manager may disqualify with a code until voting opens.
- **The list is fixed** once voting opens (a trigger). With nobody standing then, the election is cancelled (`no_candidates`) and the board told.
- **The vote is always secret.** Each unit picks 1 to `seats` candidates.
- **The count**, once, at the close: the first `seats` with a vote are elected. A tie across the last seat elects those above it and leaves the tied to the board.
- **The manager certifies it, once.**
  - With a tie, the certification carries the board's choice among the tied (exactly the seats left) and how it chose (`board_decision | lot_drawn`).
  - The open term ends (`succeeded`); the elected board sits from now for the term, its winners seated as members (the offices are recorded afterwards) and told.
  - A winner who owns no unit any more is `ineligible`: the seat stays vacant and nobody moves up.

### The board's decisions and minutes

- **Publishing.** While a board sits, a member (or the manager) publishes a decision or the minutes of a meeting. It becomes an announcement of a new kind, `board`, to the owners, out at once at normal priority (nobody is pushed), with an optional PDF of `community_attachment` (which board members may now upload).
- **The record.** Governance keeps it in `board_publications`: the kind, the board, and the day decided (today or up to a year ago).
- **Corrections and archiving.** The words are corrected by a new version of the announcement; archiving takes it down for good.
- **Only the board's.** The staff's announcement routes never write the kind `board` and refuse to change such an announcement (`ANNOUNCEMENT_OF_THE_BOARD`). A deferred trigger holds that an announcement is of kind `board` exactly when a publication names it.

### Notifications

Category `governance`; nothing is critical; params are codes only.

| Kind | To |
|---|---|
| `governance_board.seat` `{role}` | the account seated |
| `governance_poll.opened` | the electors |
| `governance_poll.closing_soon` | the electors whose unit has not voted, once, a day before the close (none for a poll shorter than a day) |
| `governance_poll.result` `{result}` | the electors and the sitting board |
| `governance_election.nominations_opened` | every owner |
| `governance_election.opened` | the electors |
| `governance_election.closing_soon` | as for polls |
| `governance_election.awaiting_certification` `{tied}` | `governance.manage` holders and the sitting board |
| `governance_election.cancelled` `{reason}` | the sitting board |
| `governance_election.result` | the electors and every candidate |

### Privacy and audit

**The account that goes.**
- When an account owns no unit any more, or is deactivated or erased, its seat ends and its candidacies in elections not yet voted on are withdrawn by the system.
- A candidate on a list that voting opened on stays on it, and is checked at the certification.
- An erasure clears the candidate's statements, once each (`statement_cleared_at`). It keeps the votes: a participation names the account by id, and a secret ballot never named anyone.

**The audit** carries ids, roles, codes, dates and counts: never a name, a statement or a choice, not even on an open poll.

**The export** gains a `governance` section (amends ADR 0036):
- the account's board seats;
- its candidacies, with its statement while it lasts;
- per contest and unit, whether and when it voted, and the choice on an open poll only.

## Consequences

- **Migrations** `20261029090000`–`20261029090600`, then `access:sync` (`governance.read` for residents, `governance.manage` for managers).
- **Limits.** Contests under way per compound: 10. A secret contest's votes go one after the other on its box row, which is fine at a compound's scale.
- **Shared lists.** Shared catalogs gain entries: the notification category, both `reasons.ts`, the audit catalog, and the CHECK and unique maps.

## Open

- A voting-owner designation for co-owners (above), if they ask for one.
- Budgets and expenses, appeals to the board: R7b.
