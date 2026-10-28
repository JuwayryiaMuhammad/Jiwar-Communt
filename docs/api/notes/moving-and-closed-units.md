# Moving, the closed unit and its proxies: backend notes for the apps

What was built (ADR 0063, [the decision](../../decisions/0063-moving-closed-units.md)):
- moving in and out, with a checklist per move;
- the move permit's direction;
- closed mode for the owner of a unit with no primary;
- unit proxies;
- a closed unit's inspection requests and reports;
- works completion and its certificate.

The contract is `docs/api/openapi.v0.json`.

Conventions as in [unit-and-contracts.md](unit-and-contracts.md):
- every path is under `/api/v1`;
- errors carry a `code`;
- dates are the compound's days, instants are UTC;
- a step-up, where needed, is `POST /me/step-up` then `/verify`.

## Moves

A move belongs to an occupancy. A move-in is planned for you when you start living in a unit. A move-out is your notice, if you are the unit's residing primary.

- **`GET /units/{unitId}/moves`:** your moves of the unit, newest first: `MoveView[]`.
  - `reference`: `MV-` and a number;
  - `direction`: `in` or `out`;
  - `plannedOn`;
  - `status`: `planned`, `done` or `cancelled`;
  - `plannedBySomeone`: false when your occupancy's start planned it.
- **`POST /units/{unitId}/moves/move-out {plannedOn}`:** give notice.
  - `plannedOn` is from today to a year ahead.
  - `403 MOVE_NOT_ALLOWED` unless you are the residing primary. Never a delegate.
  - `409 MOVE_ALREADY_PLANNED` if you gave one already.
- **`GET /units/{unitId}/moves/{id}`:** the move with its `checklist`, a list of `{ key, side, done, at, reference }`.
  - `side: resident`: yours to tick. Today that is `guide_read`, after reading the compound's moving guide.
  - `side: management`: theirs (keys, meters, the unit's inspection).
  - `side: derived`: read from where it lives:
    - `move_permit`: an approved move permit that way; `reference` is its number.
    - `utilities_requested`: your request on the topic `utilities`.
    - `clearance_issued`: a clearance of the unit since the notice.
    - `deposits_settled`: the deposits the management holds for you hold nothing.
- **`POST /units/{unitId}/moves/{id}/steps {step}`:** tick a step of yours, once (`409 MOVE_STEP_DONE`).
- **`POST /units/{unitId}/moves/{id}/cancel {reasonCode}`:** withdraw the notice you gave.
  - `reasonCode` comes from `moveCancel`: `plans_changed`, `data_error`, `other`.
  - A move-in is the management's to cancel.

A move-out is done when the management records the handover. With no clearance on the checklist, they give a reason; the handover still happens.

**Move permits.** `POST /units/{unitId}/permits/moves` now requires `direction`: `in` or `out`. The permit serves the unit's move planned that way, and its view's `move` carries `direction` and `moveId`.

## The closed unit

`POST /units/{unitId}/closed-mode {closed}`:
- the owner primary may call it, as before;
- now also any owner of a unit with no primary;
- never a tenant (`403 NOT_PRIMARY_RESIDENT`).

The household's end, or an ownership transfer, reopens the unit. The owner of a unit with no primary also asks for its permits.

## Proxies

**Appointing.** An owner of the unit (never a delegate) appoints someone to look after it while it is closed or has no primary.
- **`POST /units/{unitId}/proxies`** takes:
  - `fullName`, `email`, `phone`;
  - the identity document, as a household invite;
  - `scopes`, one to five of `inspections`, `tickets`, `visitors_invite`, `works`, `requests`;
  - `endsOn`, a year ahead at most.
- It answers `201 { proxy, token }`, never cached. **The token is shown once**: share the link `<PUBLIC_APP_URL>/x#<token>`.
- `409 PROXY_LIMIT` at two live proxies; `403 PROXY_NOT_ALLOWED` for anyone but an owner.
- **`GET /units/{unitId}/proxies`** lists them (owners only); **`POST /units/{unitId}/proxies/{id}/revoke`** ends one.

**Accepting.** The person opens the link (`apps/public`), receives a code at that email, and accepts. They then sign in to the app with their own `proxy` account.

**The proxy's side.**
- **`GET /me/proxy-units`** lists the units they look after: `{ unitId, unitCode, scopes, expiresAt, usable }`.
- `usable` is true while the unit is closed or has no primary. Otherwise the unit's capabilities are all false.
- With the scopes:
  - **tickets and visitors:** through the usual routes, as the capabilities show (`tickets`, `visitorsInvite`);
  - **`works`:** works permits;
  - **`requests`:** requests to the management;
  - **`inspections`:** below.

## Inspections of a closed unit

For an owner of the unit, or its proxy with `inspections`:
- **`POST /units/{unitId}/inspection-requests {preferredOn}`:** ask for a visit, from today to 90 days ahead.
  - `409 INSPECTION_UNIT_NOT_CLOSED` if the unit is not closed.
  - `409 INSPECTION_REQUEST_OPEN` if one is open already.
- **`GET /units/{unitId}/inspection-requests`:** the requests, each with its `reference` (`IR-` and a number) and `status` (`open`, `scheduled`, `done` or `cancelled`).
- **`POST /units/{unitId}/inspection-requests/{id}/cancel {reasonCode}`:** cancel an open one.
  - `reasonCode` comes from `inspectionRequestCancel`.
  - A scheduled one is cancelled by the management (`409 INSPECTION_REQUEST_CLOSED`).
- **`GET /units/{unitId}/inspections`:** the inspections done, newest first, never cached: `{ taskId, requestId, doneAt, outcome, note, photos[{url, expiresAt}] }`.
  - Open the photo URLs at once.
  - Never the guard's name.
- The asker is told when it is done (`guard_task.unit_inspected`, the outcome only).

## Works completion

For the requester of an approved works permit:
- **`POST /permits/{id}/completion-inspection`:** ask for the finished works to be inspected.
  - `409 PERMIT_INSPECTION_OPEN` if one is asked already.
  - `409 PERMIT_INSPECTION_NOT_ALLOWED` if the permit is not an approved works permit, or the works passed already.
- **`GET /permits/{id}/completion-inspections`:** the rounds, `{ cycle, status, findings, certificateNumber, verifyCode }`.
  - `status` is `asked`, `passed` or `failed`.
  - `findings` comes from `worksFinding`: fix those, then ask again.
- **`GET /permits/{id}/completion-certificate`:** the certificate as a PDF, never cached, once passed.
- **The public check:** anyone checks the certificate at `<PUBLIC_APP_URL>/w#<verifyCode>`, or types the code at `/w`. It shows the compound, the number, the unit's code and the day.
- `permit_inspection.decided {outcome}` tells the requester.
- **A finishing-works deposit** (`GET /me/deposits`) shows `worksCompletion` once the works passed: `{ at, reference }`, the certificate's number. It is null until then, and for the other kinds. The refund stays the management's decision.

## Your lists and your export

- **`GET /me/requests` and `/me/search`** now include `inspection_request` (search by `IR-…`) and `works_inspection` (search by the certificate's `WC-…`), each as its own list route shows them.
- **A personal-data export** now carries these files: `contracts.json`, `unit-documents.json`, `registrations.json`, `moves.json`, `proxies.json`, `clearances.json`, `deposits.json`, `inspection-requests.json`. They are records only, never another person's details.

## Notifications

| Kind | Params | To |
|---|---|---|
| `unit_move.notice_given` | `plannedOn` | the management (`residents.manage`) |
| `unit_inspection.requested` | `preferredOn` | security (`guard_tasks.manage`) |
| `permit_inspection.requested` | `cycle` | the management (`permits.manage`) |
| `permit_inspection.decided` | `outcome` | the requester |

## Errors

New codes:
- **Moves:** `MOVE_NOT_FOUND`, `MOVE_NOT_ALLOWED`, `MOVE_NOT_PLANNED`, `MOVE_ALREADY_PLANNED`, `MOVE_STEP_DONE`, `MOVE_HANDOVER_REASON_REQUIRED`.
- **Proxies:** `PROXY_NOT_FOUND`, `PROXY_NOT_ALLOWED`, `PROXY_LIMIT`.
- **Inspection requests:** `INSPECTION_REQUEST_NOT_FOUND`, `INSPECTION_NOT_ALLOWED`, `INSPECTION_UNIT_NOT_CLOSED`, `INSPECTION_REQUEST_OPEN`, `INSPECTION_REQUEST_CLOSED`.
- **Works completion:** `PERMIT_INSPECTION_NOT_FOUND`, `PERMIT_INSPECTION_NOT_ALLOWED`, `PERMIT_INSPECTION_OPEN`, `PERMIT_INSPECTION_DECIDED`, `WORKS_CERTIFICATE_NOT_FOUND`.
