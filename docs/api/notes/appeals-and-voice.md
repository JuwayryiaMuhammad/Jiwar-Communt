# Appeals and the owners' voice: backend notes for the mobile team

What R11b-2 built for residents and owners:
- an appeal of a staff decision about their unit, to the management, and then to the board;
- a complaint about the management, to the board;
- the building's representative, and a private conversation with them;
- a matter proposed for the board's agenda;
- an objection to a decision of the board;
- how a request the board approved is followed up.

The design decisions are in [ADR 0059](../../decisions/0059-appeals-and-owners-voice.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors carry `code` and `fields[].code`; switch on those, never on `message`.
- Send an `Idempotency-Key` with every create and every decision.

## Contents

1. [Appealing a decision to the management](#appealing-a-decision-to-the-management)
2. [Taking it to the board](#taking-it-to-the-board)
3. [Complaining about the management](#complaining-about-the-management)
4. [The building's representative](#the-buildings-representative)
5. [Agenda proposals](#agenda-proposals)
6. [Objections to a decision](#objections-to-a-decision)
7. [How a decision is followed up](#how-a-decision-is-followed-up)
8. [Push notifications](#push-notifications)
9. [Errors](#errors)

---

## Appealing a decision to the management

Who may appeal, within **15 days** of the decision, **once per decision**:

| `kind` | `subjectId` | Who |
|---|---|---|
| `permit_rejection` | a rejected permit | the unit's primary |
| `vehicle_rejection` | a rejected vehicle | its keepers or the primary |
| `worker_rejection` | a rejected worker's engagement (the push `worker.engagement_rejected` carries it) | the household's employer side |
| `neighbour_notice` | a notice the unit received | its recipients |

```http
POST /decision-appeals
{ "kind": "permit_rejection", "subjectId": "…", "grounds": "The works were within the hours.", "attachmentIds": ["…"] }
```

- `grounds`: 1–2000 characters. `attachmentIds`: up to 3 uploads of purpose `decision_appeal_attachment` (an image or a PDF, 10 MB).
- `201` → the appeal: `reference` (`AP-000123`), `status` `pending`, `decision: null`, `subject` (the decision as its domain describes it: codes and dates), `mine: true`, `grounds`, `attachments`.
- `GET /decision-appeals` lists the caller's own and those of the units they are the primary of (without the grounds). `GET /decision-appeals/{id}`.
- `POST /decision-appeals/{id}/withdraw`: the appellant, while pending.
- **Decided** (`status` `upheld` or `overturned`): `decision` carries `rationale` (the manager's words), `decidedBy` (`roleKey`, `roleName`: the role, never a person), `effect` and `effectReason`:
  - `applied`: the permit is approved, the vehicle active, the notice withdrawn;
  - `follow_up`: the management acts on it by hand; `effectReason` says what stood in the way (e.g. `unit_limit`, `work_rules`, `needs_review`);
  - `none`: nothing changed (upheld, or the decision changed since: `changed`).
- `GET /me/appeals` lists it as `type: "decision_appeal"`, with `appeal.decidedBy: "management"` and `appeal.deciderRole`.

## Taking it to the board

An appeal the management **upheld** can be taken on to the board by an owner of the unit or its primary, within 15 days of that decision, as any board appeal:

```http
POST /governance/board-appeals
{ "kind": "management_appeal", "subjectId": "<the decision appeal's id>", "grounds": "…" }
```

The board's overturn applies the same effect through the same checks; what needs a person (a vehicle's sticker, a worker's review) is left to the management. The decision appeal shows `takenToBoardAt`.

## Complaining about the management

An owner of a unit, or its primary:

```http
POST /governance/management-complaints
{ "unitId": "…", "category": "delay", "requestNumber": 123, "grounds": "Nobody answered for a month." }
```

- `category`: `conduct`, `delay`, `unfair_decision`, `service_quality`, `other`. `requestNumber`: the management request's number (`MR-000123` is `123`), optional.
- It is a board appeal of kind `management_complaint` (`201` → the board appeal), read and withdrawn as one. **At most three open** at once (`409 MANAGEMENT_COMPLAINT_LIMIT`, `params.max: 3`).
- Only its author sees it. The management never learns its unit or its grounds. Overturned means founded.

## The building's representative

The board names one per building, and ends a term, by its own decision (a matter it votes on; see the board's side below). For the residents:

- `GET /me/representatives`: the representative of each building the caller lives or has a place in: `{ id, building, firstName, since }`.
- `POST /me/representatives/{id}/messages` `{ "body": "…" }` (1–2000): a private conversation; the representative sees the caller's unit code and first name. `GET /me/representatives/{id}/messages`: oldest first; empty before the first message.
- `409 REPRESENTATIVE_ENDED` once their term ended; `404 REPRESENTATIVE_NOT_FOUND` outside the building.

**The representative** (an owner, `governance.read`):
- `GET /me/representation/threads`: latest first, each `{ id, building, unitCode, writerFirstName, lastMessageAt }`.
- `GET /me/representation/threads/{id}/messages`, `POST …/messages` `{ "body": "…" }`.

A message whose author was erased reads `body: null`.

**The board** (a sitting member, `governance.board`): naming or ending one is a matter decided by the board's motions, as an approval request is.
- `GET /board/representatives/buildings` and `GET /board/representatives/candidates?building=A` (the building's active owners, with their units there): whom it may name.
- `POST /board/representatives/matters` `{ "action": "appoint", "building": "A", "accountId": "…" }` or `{ "action": "end", "representativeId": "…" }`: one pending per building (`409 REPRESENTATIVE_MATTER_PENDING`, `params.matterId`); `REPRESENTATIVE_ALREADY_SITTING` for the sitting one.
- `POST /board/representatives/matters/{id}/motions` `{ "outcome": "approve", "rationale": "…" }`, then `POST /board/motions/{id}/votes` as for every motion. Whom it names is recused (`BOARD_MEMBER_RECUSED`).
- `GET /board/representatives/matters?status=pending`, `GET …/{id}` (with its motions). Once decided, `decision` carries the reasons and `effect`: `applied`, or `not_applied` with `effectReason` (`not_an_owner`, `already_sitting`, `already_ended`).
- `POST /board/representatives/matters/{id}/withdraw`: its raiser, while pending.

## Agenda proposals

- `POST /governance/agenda-proposals` `{ "title": "…", "body": "…" }` (200 and 4000 at most): an owner, **three open at most** (`409 AGENDA_PROPOSAL_LIMIT`).
- `GET /governance/agenda-proposals`, `GET …/{id}`: the caller's own. `POST …/{id}/withdraw` while `open`.
- `status`: `open`, `accepted`, `declined` (with `declineReason`: `out_of_scope`, `duplicate`, `not_now`, `other`), `withdrawn`; `decisionNote` is the board's words. Accepting binds nothing.

**A sitting member:** `GET /board/agenda-proposals?status=open`, `GET …/{id}`, `POST …/{id}/decide` `{ "outcome": "declined", "reasonCode": "not_now", "note": "…" }`.

## Objections to a decision

- `GET /governance/publications` shows, on each decision, `objections: { until, answered }` (null on minutes or an archived decision).
- `POST /governance/publications/{id}/objections` `{ "unitId": "…", "grounds": "…" }`: once for each unit the caller owns (`409 OBJECTION_EXISTS`), before `until` (`409 OBJECTION_WINDOW_PASSED`), while not answered (`409 OBJECTION_NOT_OPEN`, `params.reason`).
- `GET /governance/objections`: the caller's, each with the board's `answer` once given.

**A sitting member:** `GET /board/publications/{id}/objections` (`count`, the grounds, never whose) and `POST …/objections/answer` `{ "body": "…" }`, once; every objector is told.

## How a decision is followed up

A decision the board published by itself shows `followUp: { status, at }` (`in_progress`, `implemented`, `cannot_implement`). The management records the steps; the owners read the last.

## Push notifications

| Kind | To | Params |
|---|---|---|
| `decision_appeal.decided` | the appellant and the unit's primary | `kind`, `outcome` |
| `worker.engagement_rejected` | who registered the worker | `reason` |
| `governance_representative.appointed` / `.ended` | the representative | `building` (`reason` when ended) |
| `representative.message_received` | the representative | — |
| `representative.replied` | the resident | — |
| `governance_agenda.decided` | the proposer | `outcome` |
| `governance_objection.answered` | every objector | — |

The staff's and the board's (`decision_appeal.lodged`, `governance_agenda.proposed`, `governance_objection.lodged`) never reach a resident's device.

## Errors

| Code | When |
|---|---|
| `DECISION_APPEAL_NOT_ALLOWED` (403) | not one of those the decision is about |
| `DECISION_APPEAL_SUBJECT_NOT_FOUND` (404) | no such decision, or not one the caller sees |
| `DECISION_APPEAL_EXISTS` (409) | appealed already |
| `DECISION_APPEAL_NOT_ELIGIBLE` (409) | `params.reason`: `not_decided`, `not_in_force`, `appealed` |
| `DECISION_APPEAL_WINDOW_PASSED` (409) | `params.until` |
| `DECISION_APPEAL_NOT_PENDING` (409) | decided or withdrawn |
| `DECISION_APPEAL_NOT_YOURS` (403) | withdrawn by someone else than the appellant |
| `MANAGEMENT_COMPLAINT_LIMIT` (409) | three open already |
| `REPRESENTATIVE_NOT_FOUND` (404), `REPRESENTATIVE_ENDED` (409), `REPRESENTATIVE_THREAD_NOT_FOUND` (404) | as above |
| `REPRESENTATIVE_MATTER_NOT_FOUND` (404), `REPRESENTATIVE_MATTER_PENDING`, `REPRESENTATIVE_ALREADY_SITTING` (409), `REPRESENTATIVE_MATTER_NOT_YOURS` (403) | the board's matters, as above |
| `AGENDA_PROPOSAL_LIMIT` (409), `AGENDA_PROPOSAL_NOT_OPEN` (409), `AGENDA_PROPOSAL_NOT_FOUND` (404) | as above |
| `OBJECTION_NOT_ALLOWED` (403), `OBJECTION_EXISTS`, `OBJECTION_WINDOW_PASSED`, `OBJECTION_NOT_OPEN` (409) | as above |
