# Governance: backend notes for the mobile team

What was built for the owners' association:
- the board, with its term and offices;
- binding polls of the owners, one vote per unit, with a quorum and a pass threshold, secret or open;
- elections of the board, with nominations, a secret vote and a certified result;
- the board's decisions and minutes, as announcements.

The design decisions are in [ADR 0051](../../decisions/0051-governance-board-votes-elections.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once. **Send one with every vote**: a retry after a lost answer must not look like a second vote.
- **Every response here is `Cache-Control: no-store`.** Do not cache them on the device.
- Instants are ISO 8601 UTC.

## Contents

1. [Who sees governance](#who-sees-governance)
2. [The board](#the-board)
3. [Polls](#polls)
4. [Voting](#voting)
5. [Elections](#elections)
6. [For board members](#for-board-members)
7. [Decisions and minutes](#decisions-and-minutes)
8. [Push notifications](#push-notifications)
9. [Value lists](#value-lists)
10. [Errors](#errors)
11. [Not built](#not-built)

---

## Who sees governance

- **The owners of a unit**, landlords included. Everyone else, tenants and household members alike, gets `404 GOVERNANCE_NOT_AVAILABLE` on every read below: hide the Governance tab for them. (A household member's role does not even hold the permission: `403`.)
- **Each unit has one vote**, cast by its **voting owner**: the primary occupant when they own the unit, otherwise its longest-standing owner. Several owners of one unit share that one vote. An owner of several units votes once per unit.
- **The electorate is fixed when a vote opens.** `myUnits` on a poll or an election lists exactly the units whose vote the caller casts in it. Someone who sells a unit while a vote is open keeps that unit's vote in it.
- **A sitting board member** holds `governance.board`, listed in `GET /me` → `permissions` while the seat lasts. Show the board tools when it is there; it goes the moment the seat or the term ends.

### Where each list lives

An owner sees two kinds of poll and two kinds of notice. They come from different routes and are never mixed by the server: keep them apart in the app, and label them.

| What | Route | Who sees it |
|---|---|---|
| **Governance polls**: binding, owners only, one vote per unit, a quorum and a threshold, a vote never changes | `GET /governance/polls` | Owners |
| **Community polls** (ADR 0040): consultative, no quorum, a vote may change until the close | `GET /polls` | Its audience: residents, owners or tenants |
| **Elections** of the board | `GET /governance/elections` | Owners |
| **The board** now, and its past terms | `GET /governance/board`, `GET /governance/board/terms` | Owners |
| **The board's decisions and minutes** | `GET /governance/publications` | Owners |
| **Announcements**: management's, and the board's as kind `board` | `GET /announcements` (`?kind=board` for the board's alone) | Their audience; the board's go to owners |

A vote goes to the list it came from: `POST /governance/polls/{id}/votes` or `POST /polls/{id}/votes`, never the other. Show a governance poll's quorum and threshold next to it, so an owner knows the vote binds.

## The board

### `GET /governance/board` → `200`

```json
{
  "board": {
    "id": "…",
    "source": "elected",
    "electionId": "…",
    "seats": 5,
    "startsAt": "2026-11-01T09:00:00.000Z",
    "endsAt": "2028-11-01T09:00:00.000Z",
    "endedAt": null,
    "status": "current",
    "members": [
      { "id": "…", "role": "chair", "fullName": "Mona Adel", "addedAt": "…", "endedAt": null }
    ]
  }
}
```

- `board` is `null` when no board sits: none yet, or the last term lapsed.
- Members are shown by name and role only.

### `GET /governance/board/terms` → `200`

The terms, newest first, each with everyone who sat in it (`endedAt` set on a seat that ended early).

## Polls

### `GET /governance/polls?status=open` → `200` · `GET /governance/polls/{id}` → `200`

`status`: `scheduled`, `open`, `closed`, `cancelled` (absent: all).

```json
{
  "id": "…",
  "reference": "GP-0007",
  "kind": "yes_no",
  "titleEn": "Repaint the fence", "titleAr": null,
  "bodyEn": "Green or not green.", "bodyAr": null,
  "secret": true,
  "rollCallPublic": false,
  "quorumPct": 50,
  "thresholdPct": 50,
  "opensAt": "…", "closesAt": "…",
  "status": "open",
  "electorate": 120,
  "turnout": 41,
  "options": [
    { "id": "…", "key": "yes", "labelEn": null, "labelAr": null, "votes": null },
    { "id": "…", "key": "no", "labelEn": null, "labelAr": null, "votes": null },
    { "id": "…", "key": "abstain", "labelEn": null, "labelAr": null, "votes": null }
  ],
  "result": null,
  "winningOptionId": null,
  "cancelReasonCode": null,
  "myUnits": [{ "unitId": "…", "unitCode": "B-12", "voted": false, "mayVote": true }],
  "rollCall": null
}
```

- **Answers.** `kind: yes_no` has the options `yes`, `no`, `abstain` (by `key`; write your own words for them). `kind: choice` has 2–10 options with labels in the poll's languages; one is picked.
- **No counts while voting is open.** `votes` is `null` until the poll closes, for everyone, the board and the management included. `turnout` and `electorate` show.
- **The result**, once closed: `passed`, `failed`, `no_quorum` or `tied` (a choice poll whose top options are equal). `winningOptionId` is set on a passed choice poll.
  - The quorum counts every unit that voted, abstentions too.
  - The threshold is a share of yes and no on a yes/no poll (abstentions left out), and of all votes for the first option of a choice poll.
- **`rollCallPublic: true` marks an open vote.** Each unit's choice is shown to the owners, by unit code, after the poll closes (`rollCall`). **Before the vote button, show a clear notice**, for example: "Open vote: your unit's choice will be visible to owners after the poll closes." A secret poll (`rollCallPublic: false`) never has a roll call: no choice is stored with its unit.
- An owner who no longer owns a unit, but votes for one in a poll that opened before, can still `GET` that poll by id. The list `GET /governance/polls` is for current owners only.

## Voting

### `POST /governance/polls/{id}/votes` → `201`

```json
{ "unitId": "…", "optionIds": ["…"] }
```

```json
{ "pollId": "…", "unitId": "…", "votedAt": "2026-11-03T10:15:02.000Z" }
```

- **One option.** Exactly one option, or `400` with `fields: [{ "field": "optionIds", "code": "INVALID_LENGTH" }]`.
- **Once per unit, for good.** There is no changing a vote, secret or open: a second vote is `409 GOVERNANCE_ALREADY_VOTED`. Ask the voter to confirm before sending.
- **Only the unit's voting owner** for this poll (`myUnits`); anyone else gets `403 GOVERNANCE_NOT_ELECTOR`.
- **Only while open.** `409 GOVERNANCE_CONTEST_NOT_OPEN` (`params.status`) before it opens or once it closes, by the server's clock.
- **The answer never says what was chosen.** It is the same for every choice, and so is its replay with the same `Idempotency-Key`. The app cannot show a secret vote back: show "Your unit voted", from `myUnits[].voted`.

### Elections: `POST /governance/elections/{id}/votes` → `201`

```json
{ "unitId": "…", "candidateIds": ["…", "…"] }
```

- 1 to `seats` distinct candidates of the election's list (`INVALID_LENGTH`, `INVALID_VALUE`).
- Elections are always secret. Otherwise the same rules as a poll.

## Elections

### `GET /governance/elections?phase=` → `200` · `GET /governance/elections/{id}` → `200`

```json
{
  "id": "…",
  "reference": "GE-0002",
  "titleEn": "The board, 2027", "bodyEn": "Five seats.",
  "seats": 5,
  "termMonths": 24,
  "nominationsOpenAt": "…", "nominationsCloseAt": "…",
  "votingOpensAt": "…", "votingClosesAt": "…",
  "phase": "nominating",
  "electorate": null,
  "turnout": null,
  "tiedCandidateIds": [],
  "certifiedAt": null,
  "termId": null,
  "cancelReasonCode": null,
  "candidates": [
    { "id": "…", "fullName": "Karim Fathy", "statement": "I will fix the lifts.", "votes": null, "outcome": null }
  ],
  "myUnits": [],
  "myCandidacy": null
}
```

- **Phases:** `upcoming` → `nominating` → `nominations_closed` → `voting` → `closed` (counted, waiting for the management to certify) → `certified`; or `cancelled` (with `cancelReasonCode`, `no_candidates` when nobody stood).
- **Candidates.** `candidates` lists those standing. `votes` and `outcome` are set once voting closes: `elected`, `tied`, `not_elected`, `ineligible` (no longer an owner: the seat stays vacant).
- **A tie.** A tie across the last seat leaves the tied candidates in `tiedCandidateIds` until the board's choice is recorded at the certification.
- **Once certified**, `termId` is the board it seated, now in `GET /governance/board`.

### Standing: `POST /governance/elections/{id}/candidacy` → `201`

```json
{ "statement": "I will fix the lifts." }
```

- **An owner**, while nominations are open (`409 GOVERNANCE_NOMINATIONS_CLOSED`), once (`409 GOVERNANCE_ALREADY_CANDIDATE`). Anyone else gets `403 GOVERNANCE_CANDIDACY_NOT_ALLOWED`.
- **The statement** is optional, 1–500 characters, shown to the owners beside the name.
- **The answer** is the election, with `myCandidacy` (`nominated`, `withdrawn`, or `disqualified` with its `reasonCode`).

### Withdrawing: `POST /governance/elections/{id}/candidacy/withdraw` → `200`

While nominations are open. Once voting opens the list is fixed.

## For board members

With `governance.board` in `/me` → `permissions`:

| Action | Route |
|---|---|
| Put a poll | `POST /governance/polls` |
| Change it before it opens | `PATCH /governance/polls/{id}` (anything but `secret`) |
| Cancel it | `POST /governance/polls/{id}/cancel` `{ reasonCode }` |
| Call an election | `POST /governance/elections` |
| Change it before nominations open | `PATCH /governance/elections/{id}` (not `seats`) |
| Cancel it | `POST /governance/elections/{id}/cancel` |
| Publish a decision or minutes | `POST /governance/publications` |
| Correct one | `PATCH /governance/publications/{id}` |
| Archive one | `POST /governance/publications/{id}/archive` |

- A seat that ended a moment ago is refused: `403`, with `FORBIDDEN` or `BOARD_SEAT_REQUIRED`.
- At most 10 polls and elections may be under way per compound: `409 GOVERNANCE_LIMIT_REACHED`.

A poll:

```json
{
  "kind": "yes_no",
  "titleEn": "Repaint the fence", "bodyEn": "Green or not green.",
  "secret": true,
  "quorumPct": 50, "thresholdPct": 50,
  "opensAt": "2026-11-05T08:00:00.000Z",
  "closesAt": "2026-11-12T20:00:00.000Z"
}
```

- `opensAt` is optional: absent or past means now, and at most 90 days ahead.
- Voting lasts 1 hour to 60 days.
- A `choice` poll adds `options: [{ "labelEn": "Green" }, { "labelEn": "Blue" }]`, in the poll's languages.

An election:

```json
{
  "titleEn": "The board, 2027", "bodyEn": "Five seats.",
  "seats": 5, "termMonths": 24,
  "nominationsCloseAt": "…", "votingOpensAt": "…", "votingClosesAt": "…"
}
```

- Nominations last 24 hours to 30 days.
- Voting opens at their close or up to 14 days later, and lasts 1 hour to 60 days.

## Decisions and minutes

### `GET /governance/publications` → `200`

The board's decisions and minutes, newest first, archived ones left out:

```json
{
  "id": "…", "kind": "decision", "decidedOn": "2026-11-01",
  "termId": "…", "announcementId": "…",
  "titleEn": "The pool reopens", "bodyEn": "…",
  "hasAttachment": true, "publishedAt": "…", "editedAt": null, "archivedAt": null
}
```

- Each is also an announcement of kind `board` in the owners' feed (`GET /announcements?kind=board`).
- Open its PDF from `GET /announcements/{announcementId}` → `attachments`.
- Nobody is pushed.

### Publishing (board members): `POST /governance/publications` → `201`

```json
{
  "kind": "minutes", "decidedOn": "2026-11-01",
  "titleEn": "Minutes of the November meeting", "bodyEn": "…",
  "attachmentFileId": "…"
}
```

- The PDF is uploaded first as `community_attachment` (`POST /files/uploads`, then finalize). Not a PDF: `400`, field `attachmentFileId`, code `FILE_TYPE_NOT_ALLOWED`.
- `decidedOn` is today or up to a year ago (`DAY_OUT_OF_RANGE`).
- Only while a board sits (`409 BOARD_NOT_SITTING`).

## Push notifications

Category `governance`; none is critical. The lock-screen texts are generic, in Arabic and English: no title, no name, no choice.

| Kind | To | Target | Params |
|---|---|---|---|
| `governance_board.seat` | the member seated | `board_term` | `role` |
| `governance_poll.opened` | the electors | `governance_poll` | |
| `governance_poll.closing_soon` | electors whose unit has not voted, a day before the close | `governance_poll` | |
| `governance_poll.result` | the electors and the board | `governance_poll` | `result` |
| `governance_election.nominations_opened` | every owner | `governance_election` | |
| `governance_election.opened` | the electors | `governance_election` | |
| `governance_election.closing_soon` | as for polls | `governance_election` | |
| `governance_election.awaiting_certification` | the management and the board | `governance_election` | `tied` (`yes` / `no`) |
| `governance_election.cancelled` | the board | `governance_election` | `reason` |
| `governance_election.result` | the electors and the candidates | `governance_election` | |

Open the target with `GET /governance/polls/{targetId}`, `GET /governance/elections/{targetId}` or `GET /governance/board`.

---

## Value lists

| List | Values |
|---|---|
| `BoardRole` | `chair`, `secretary`, `treasurer`, `member` |
| `BoardTermStatus` | `current`, `lapsed`, `ended` |
| `GovernancePollKind` | `yes_no`, `choice` |
| `GovernanceContestStatus` | `scheduled`, `open`, `closed`, `cancelled` |
| `GovernancePollResult` | `passed`, `failed`, `no_quorum`, `tied` |
| `GovernanceElectionPhase` | `upcoming`, `nominating`, `nominations_closed`, `voting`, `closed`, `certified`, `cancelled` |
| `GovernanceCandidateStatus` | `nominated`, `withdrawn`, `disqualified` |
| `GovernanceCandidateOutcome` | `elected`, `tied`, `not_elected`, `ineligible` |
| `BoardPublicationKind` | `decision`, `minutes` |
| `governancePollCancel` (you send) | `created_in_error`, `superseded`, `board_decision`, `other` |
| `governanceElectionCancel` (you send) | `created_in_error`, `postponed`, `board_decision`, `other` |
| `governanceElectionSystemCancel` | `no_candidates` |
| `governanceCandidateDisqualify` (the management) | `not_eligible`, `statement_breaks_rules`, `other` |
| `governanceCandidateSystemWithdraw` | `no_longer_owner`, `account_closed` |
| `governanceTieBreak` (the management) | `board_decision`, `lot_drawn` |
| `boardMemberEnd` (the management) | `resigned`, `removed`, `misconduct`, `other` |
| `boardMemberSystemEnd` | `no_longer_owner`, `account_closed` |

## Errors

| Code | When |
|---|---|
| `GOVERNANCE_NOT_AVAILABLE` (404) | the caller owns no unit |
| `GOVERNANCE_POLL_NOT_FOUND`, `GOVERNANCE_ELECTION_NOT_FOUND`, `GOVERNANCE_CANDIDATE_NOT_FOUND`, `BOARD_PUBLICATION_NOT_FOUND` (404) | unknown, or not this compound's |
| `GOVERNANCE_NOT_ELECTOR` (403) | the caller does not cast this unit's vote here |
| `GOVERNANCE_ALREADY_VOTED` (409) | the unit voted already |
| `GOVERNANCE_CONTEST_NOT_OPEN` (409, `params.status`) | not open for votes |
| `GOVERNANCE_CONTEST_STARTED` (409) | a change after it opened |
| `GOVERNANCE_CONTEST_ENDED` (409) | it closed, was certified or cancelled |
| `GOVERNANCE_NOMINATIONS_CLOSED` (409, `params.phase`) | standing or withdrawing outside nominations |
| `GOVERNANCE_CANDIDACY_NOT_ALLOWED` (403) | not an owner |
| `GOVERNANCE_ALREADY_CANDIDATE` (409) | standing twice |
| `GOVERNANCE_LIMIT_REACHED` (409, `params.max`) | too many under way |
| `BOARD_SEAT_REQUIRED` (403) | a board action without a seat |
| `BOARD_NOT_SITTING` (409) | publishing while no board sits |

## Not built

- Budgets, expenses and appeals to the board (R7b).
- Choosing among co-owners who casts a unit's vote: the rule above decides for now.
