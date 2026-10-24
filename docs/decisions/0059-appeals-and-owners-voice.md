# 0059 — Appeals of the management's decisions, at the management and then the board; complaints about the management; and the owners' voice: building representatives, agenda proposals, objections to the board's decisions and the follow-up of what it approved

- **Status:** Accepted
- **Date:** 2026-10-24
- **Builds on:** ADR 0039 (requests to the management), 0042 (complaints between units), 0045 (vehicles), 0049 (permits), 0051 (governance), 0055 (board matters), 0058 (the resident's side)

## Context

ADR 0058 (R11b-1) gave residents one list of what they asked for and appealed. The appeals it lists were the fines' and violations' only, and the board took four kinds of staff decision. R11b-2 closes the rest of the 10-21 audit:
- a staff decision about a unit can be appealed to the management, and then to the board;
- the management can be complained about to the board;
- the owners have a voice between elections: a representative per building, matters for the board's agenda, objections to what it decided, and the follow-up of what it approved.

The user's rules for this part:
- An overturn that approves a permit or activates a vehicle runs the same checks as a normal approval. A check that refuses makes the effect `follow_up`, never a forced approval.
- At most three open complaints about the management per owner (409 with its code).
- Calendar days in tests come from `test/setup/compound-clock`; milliseconds only for real durations, each with a reasoned `eslint-disable`.
- Naming or ending a building's representative is a board decision, by ADR 0055's motions as approvals are; accepting or declining an agenda proposal binds nothing and stays with one sitting member.
- The board's pages (representatives with the motion, agenda proposals, objections with its single answer) are in the manager dashboard's board section, as R7b's.

## Decisions

### 1. Decision appeals to the management

- **What may be appealed**, by whom, within **15 days** of the decision (the instant, as the board's window), **once per decision**:

  | Kind | The decision | Who appeals |
  |---|---|---|
  | `permit_rejection` | a permit the staff rejected | the unit's primary |
  | `vehicle_rejection` | a vehicle the staff rejected | its keepers (whoever holds `vehicles` on the unit) or the primary |
  | `worker_rejection` | a worker's engagement the management rejected | the employer side (ADR 0037's wage readers: the primary, a live `workers` delegate, the registrant while they live there) |
  | `neighbour_notice` | a notice sent to the unit | its recipients, while they still answer for the unit |

- **The appeal** (`decision_appeals`, `AP-000123`): grounds (2000 at most, cleared at the appellant's erasure), up to three attachments (`decision_appeal_attachment`), the decision's time and decider as the domain says them.
- **Decided by** `appeals.decide` (the manager), **never by the one who took the decision** (`409 APPEAL_DECIDER_CONFLICT`), once, with a rationale (kept). The decider's role is kept as it was named then; residents read the role, never a person.
- **Who reads it:** the appellant (with the grounds), the unit's primary (without them), the deciders (all).
- **A core registry** (`DecisionAppeals`, as `BoardMatters`) carries each kind's domain handler: it says who may appeal, locks and judges the decision at the lodge, marks it, and applies an overturn in the deciding transaction. The management imports neither the gate nor neighbours.
- **What an overturn does** — the domain's normal approval, every check it makes, in its own lock order. A refusal leaves the decision as it was and the overturn to the management (`follow_up`, with the reason code), marked followed up once:

  | Kind | Applied | Left to follow up when |
  |---|---|---|
  | Permit | approved; the rejection stays as history | its window passed, its data was purged, its requester may no longer ask, the unit's live permits of the kind are at the limit, the compound's work days or hours refuse it, a plate on it is banned |
  | Vehicle | activated, with the sticker and the permit's last day **the deciding manager gives** | no sticker given, the registrant may no longer keep vehicles there, the unit is at its limit, another vehicle holds the plate, the day is out of range, the sticker was issued before |
  | Worker | never: an approval issues a code and, for a passport, needs a person | always (`needs_review`) |
  | Notice | withdrawn, once | — |

  A vehicle re-plated, or a permit no longer rejected, since the appeal did not stand as appealed: the effect is `none` (`changed`).
- **The permit's mark:** an open appeal keeps the purge away from a rejected permit's data; the mark closes with the appeal and opens again if the management's decision goes to the board.
- **A worker's review** now keeps when it decided and a rejection's code, and tells whoever registered the worker (`worker.engagement_rejected`, with the code). Rejections from before kept neither and cannot be appealed (`not_decided`).
- **A neighbour notice** gains `withdrawnAt`, set only by an overturn; the unit and the staff see it.

### 2. The board's new kinds (on ADR 0055)

- **`management_appeal`**: a decision appeal the management **upheld**, taken on by an owner of the unit or its primary within 15 days. It marks the decision appeal while the board has it. The board's overturn applies the same domain effect through the same checks, with no manager deciding: what needs one (a vehicle's sticker, a worker's review) is left to follow up.
- **`management_complaint`**: an owner or a unit's primary complains about the management — a category (`conduct`, `delay`, `unfair_decision`, `service_quality`, `other`), the management request's number if any, and the grounds (the board appeal's). The board appeal is lodged with it, in one transaction.
  - **At most three open per owner**, counted under the owner's own lock: two at once for the last place, one is refused (`409 MANAGEMENT_COMPLAINT_LIMIT`, `params.max`).
  - **Its author's alone** among the residents (another owner of the unit does not see it). **The staff never learn its unit or its grounds**: the management's view has no unit code and the audit trail no unit. The board sees both (its recusals depend on them).
  - Overturned means founded: `follow_up`, for the management.

### 3. Building representatives

- **Named or ended by the board's decision** — a board matter (`governance_representative_matters`) decided by ADR 0055's motions, as an approval request is:
  - A sitting member (`governance.board`, `BOARD_SEAT_REQUIRED`) **raises** it, under the board lock: `appoint` an owner of a unit in the building (`REPRESENTATIVE_NOT_AN_OWNER`, `REPRESENTATIVE_ALREADY_SITTING`), or `end` a sitting term (`REPRESENTATIVE_ENDED`). **One pending per building** (`409 REPRESENTATIVE_MATTER_PENDING`, a partial unique index behind it); its deadline is 14 days.
  - A member **proposes a motion** (approve or reject, with the reasons); the members vote; the vote that decides it closes it. **Whom the matter names is recused** (it is snapshotted when the motion opens, as an appeal's).
  - **A carried approval applies it in the deciding transaction**: one representative at a time per building, a new one replacing the sitting one (`replaced`). It never throws for the state it finds: an owner who no longer owns a unit there (`not_an_owner`), sits already (`already_sitting`), or a term that ended meanwhile (`already_ended`) is recorded as `not_applied`, so no vote is ever stuck. The owner's occupancy there is share-locked at the decision, so an occupancy ending at the same time either is seen, or sees the new term and ends it.
  - Its raiser withdraws a pending matter (`REPRESENTATIVE_MATTER_NOT_YOURS`); its open motion closes with it.
  - The database holds it: a matter is approved or rejected exactly when one carried motion with its outcome names it (checked at commit); it moves from pending once; a term records the matter that named it and the one that ended it.
- **The term ends** by the board's matter (`ended`), by a new one (`replaced`), or by itself when they no longer own a unit there (`no_longer_owner`) or their account closes (`account_closed`).
- **The building's residents** (an occupancy or a household membership on a unit there) see the representative's **first name** and since when (`GET /me/representatives`).
- **Contact is a private thread** per resident and representative: append-only, the writer's words cleared at their erasure. The representative sees each writer's **unit code and first name**, never more. The management sees who represents which building, never the threads. Messages are not the audit trail's.

### 4. Agenda proposals

- An owner proposes a matter for the board's agenda (a title of 200 and words of 4000 at most), **three open at once** (`409 AGENDA_PROPOSAL_LIMIT`), counted under the owner's lock.
- A sitting member **accepts or declines once** (a decline with its code, `agendaDecline`; either with a note), under the board lock, with no motion: accepting binds nothing, and the board raises what it takes up as it always does.
- The proposer reads their own; the board all; the management none. The proposer may withdraw it while open; their erasure clears its words.

### 5. Objections to the board's decisions

- An owner objects to a **decision** the board published (not minutes, not archived), **once for each unit they own** (two owners of one unit at once: one, under a lock of the unit's), within the compound's **objection days** of its publication: a new `objection` row of the governance settings, 14 by default, backfilled for every compound.
- The board sees **how many and their grounds, never whose**; a sitting member **answers once**, with its reasons, told to every objector — after which the decision takes no more. An objection has no effect by itself.
- The owners' view of a decision says until when it takes objections and whether the board answered.

### 6. The follow-up of approved requests

- The manager records **progress** on an approved request (`POST /staff/governance/approvals/{id}/progress`): in progress as often as it moves, then **once** implemented or not implementable — the final step. The implemented mark is that final step (the existing route writes it too), and a decision that implements its request itself records it, by nobody.
- **A decision the board published by itself names its request**, so the owners reading it see the last step of its follow-up.

## Lock order (new paths)

- **A decision appeal's lodge:** the caller's account (shared) → the deciders it tells (key-shared, in id order) → the decision, as its domain locks it → the counter → the appeal.
- **A decision:** the caller's account → the appellant and the primary (key-shared) → the appeal (for update) → the decision, in its domain's order (a permit: the unit's lock, the compound's rules shared, the row; a vehicle: the unit's vehicles lock, the plate's lock, the row).
- **A worker's engagement** is locked alone, by its row, as the gate locks it: the community's writes take the unit's row and then reach for accounts, so taking the unit after the management's account locks would cycle with them.
- **Governance** (ADR 0051's order): the caller's account → the accounts a write tells → the board lock and the caller's seat (a board write) → the subject's row (a representative, a proposal, a publication: shared at an objection, for update at the answer) → its children.
- **A representative matter decided** (ADR 0055's motion order): the caller → whom it names and the sitting representative (key-shared) → the caller's seat and the board's seats → the matter (for update) → the motion → the owner's occupancy in the building (shared) → the building's sitting term (for update) → the new term.

## Privacy

- Audit rows carry ids, codes and times; grounds, rationales, proposals and replies only as changed. A complaint's lodge names no unit.
- Notification params are codes (`kind`, `outcome`, `reason`, a building's label); never a name, a ground or a message.
- Erasure clears an appellant's grounds and attachments, a proposal's words, an objection's grounds, a representative message's words; rationales, answers and notices stay (the compound's record).
- The data export carries the account's decision appeals (`decision-appeals/AP-….json`), its representative terms and words, its proposals and its objections with their answers.

## Consequences

- `/me/appeals` lists decision appeals too, with `appeal.deciderRole` (`{key, name}`) for the management's decisions.
- The board's appeal kinds are six; the staff's view of an appeal has a nullable `unitCode`.
- `GET /staff/governance/settings` lists the `objection` row; the approval view gains `progress`; the publication view gains `followUp` and `objections`.
- New permission `appeals.decide` (the manager), synced to existing compounds by `access:sync`.
- The manager dashboard: decision appeals to decide and follow up; a ticket's quotes; topic owners; late notices and their cure period (ADR 0058); the board's new kinds. In R7b's board section, for sitting members: the representatives with their matters and motions, the agenda proposals to answer, and the decisions' objections with the board's single answer.
- The apps' notes are in [`docs/api/notes/appeals-and-voice.md`](../api/notes/appeals-and-voice.md).

## Deviations (noted while building)

1. **Migrations start at `20261115090000`**, after P1's (`20261112…`) and the roster fix's (`20261114…`), not at the plan's `20261108090700`.
2. **A vehicle's overturn needs the deciding manager's sticker and permit day**: an approval cannot be made without them. Without them, and always at the board, the overturn is left to follow up (`needs_sticker`).
3. **A banned plate refuses a permit's overturn** (a watch does not): at creation the blocklist only notes a plate, but an overturn is a decision a person did not see.
4. **A worker's rejection is now told to its registrant**: without it, nobody could learn of the decision to appeal it.
5. **An answered decision takes no more objections**, even within its days: the answer is to those who objected.
6. **The board picks a representative from its own lists**: `GET /board/representatives/buildings` and `…/candidates?building=` (the building's active owners, with their units there), as the manager's owner directory is the management's.

## Open

- A worker's review triggered by an overturn (today the management opens it by hand).
- Formal notices of other types (a violation warning, a neighbour notice) with a cure period per type (ADR 0058's Open).
- An objection with an effect (a petition that forces a vote), if the compound's statutes give one.
