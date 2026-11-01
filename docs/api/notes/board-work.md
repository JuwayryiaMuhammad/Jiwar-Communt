# The board's work: backend notes for the dashboards and the owner app

What was built for the board's day-to-day work:
- polls weighted by each unit's ownership share, and the shares the manager records;
- the candidacy rules a compound may turn on;
- board meetings: their agenda, who was there, the minutes and the action items;
- the handover pack a new board receives, and a manager's handover;
- the monthly board report, with the compound's logo on the board's documents.

The design decisions are in [ADR 0075](../../decisions/0075-board-work.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: paths under `/api/v1` with a bearer token; lists are `{ "data": [...], "nextCursor" }`; switch on `code` and `fields[].code`, never on `message`; days are the compound's `YYYY-MM-DD`; instants ISO 8601 with an offset; reason codes from `GET /reasons`.

## Weighted polls (the owner app)

- A poll's `weighting` is `unit` (one unit, one vote) or `share`. A poll by share is never secret: it always shows its roll call after the close, so tell the voter before they vote, as for any open vote.
- By share: `electorateWeight` (the electorate's shares when voting opened) and, once closed, `turnoutWeight` and each option's `weight` beside its `votes`. The result is reckoned on the weights: show them, not only the counts.
- A unit with no share recorded weighs 0.
- The staff: `GET/PUT /staff/governance/unit-shares` (shares in % with up to four decimals; `null` clears one). `POST /governance/polls` takes `weighting: "share"` only with `secret: false` (`FIELD_NOT_ALLOWED` on `weighting` otherwise).

## Candidacy rules

- `GET/PATCH /staff/governance/rules`: `candidacyNoDues`, `candidacyNotStaff` (both off by default), `boardReportMonthly` (on), `reportLogoFileId`.
- When a rule refuses a candidacy, `POST /governance/elections/{id}/candidacy` answers `409 GOVERNANCE_CANDIDACY_NOT_ELIGIBLE` with `params.reason` `dues_outstanding` (pay first) or `staff`.

## Board meetings (the dashboard)

- `GET/POST /board/meetings`, `GET/PATCH /board/meetings/{id}`: a sitting member or the manager.
  - The agenda is items of kind `approval_request`, `board_appeal` or `agenda_proposal` (a `subjectId` of a matter still open), or `other` (a `title`).
  - Each item comes back with its `reference` and its `subjectStatus` now.
- `POST …/{id}/hold { presentMemberIds }` records the meeting held, once, from the seats sitting now. The answer carries `seated`, `present` and `quorate`, and the attendance.
- `POST …/{id}/cancel { reasonCode }` (`boardMeetingCancel`).
- `POST …/{id}/minutes { publicationId }`: a `minutes` publication of the same board, published with `POST /governance/publications` first.
- `POST …/{id}/actions { title, ownerAccountId, dueOn }`: the owner is a seat of the meeting's board or a manager.
  - `GET /board/meeting-actions?status&mine` lists them; `POST /board/meeting-actions/{id}/done { note? }` and `…/cancel { reasonCode }` (`boardActionCancel`) close one.
  - A meeting's `followUp` lists the open items of the same board's earlier meetings.
- Errors: `BOARD_MEETING_NOT_SCHEDULED`, `BOARD_MEETING_NOT_HELD`, `BOARD_MEETING_BOARD_GONE`, `BOARD_MEETING_MINUTES_LINKED`, `BOARD_MEETING_ACTION_CLOSED`.

## Handovers

- `GET /board/handover-pack` (and `/pdf`): what the board before left open when the sitting board started to sit. A board seated before this release has none (`BOARD_HANDOVER_PACK_NOT_FOUND`).
- The leaving manager: `GET/PUT /staff/governance/handover { notes }`, then `POST …/deliver`, once. `GET /board/manager-handovers`, `…/{id}` and `…/{id}/pdf` list and show the delivered ones.
- While a board sits, deactivating a manager who delivered nothing answers `409 HANDOVER_PENDING`, on the platform too. The board may approve going without: raise `manager_handover_override` with `managerAccountId` (`POST /staff/governance/approvals`).

## The monthly report

- `GET /board/reports`, `GET …/{id}` and `…/{id}/pdf`; `POST /board/reports { month: "YYYY-MM" }` draws a month again, as its next `version`.
- The sitting board is told (`board_report.ready`) when the month before's is written. `bySweep` marks the monthly one, written only in a compound that has had a board; any compound's manager draws a month on demand.
- `contents.governance` holds the board's figures; `contents.sections` holds the overview's (finance, security).

## Notifications

`board_meeting.scheduled` `{kind}`, `board_meeting.cancelled` `{reason}`, `board_meeting_action.assigned`, `board_meeting_action.overdue`, `manager_handover.delivered`, `board_report.ready`: all in `governance`, none critical.
