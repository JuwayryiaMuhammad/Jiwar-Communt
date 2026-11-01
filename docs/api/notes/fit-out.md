# Fit-out completion: backend notes for the mobile team and the dashboard

What was built around a works permit's finishing works:
- the deposit held for the works;
- the works' drawings;
- debris removals;
- the common areas before and after the works;
- damage claims and their appeal;
- the completion certificate, which waits for open violations and claims.

The design decisions are in [ADR 0074](../../decisions/0074-fitout-completion.md); the permits themselves in [permits.md](permits.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions as in API v0:
- Every path is under `/api/v1`.
- Errors carry a `code`; switch on it, never on `message`.
- **Every response here is `Cache-Control: no-store`**: they carry presigned file URLs.
- Local days (`YYYY-MM-DD`) and times of day (`HH:mm`) are in the compound's time zone.

## The fit-out of a works permit

| Who | Route |
|---|---|
| the requester, or the unit's primary now | `GET /permits/{id}/fit-out` |
| `permits.manage` | `GET /staff/unit-permits/{id}/fit-out` |

Another permit, a move, an event, or a permit the caller has no part in: **404 `PERMIT_NOT_FOUND`**.

`FitOutView`:

| field | what |
|---|---|
| `permitId`, `reference`, `status` | the permit (`status` as the permit views show it, `ended` included) |
| `depositRequired` | the compound approves works only once their deposit holds money |
| `deposit` | `{ number, amount, held }` of the finishing-works deposit named on the permit, or `null` |
| `drawings` | `{ id, addedAt, file: { url, expiresAt } \| null }`, oldest first |
| `debrisSlots` | the removals (below), by their window |
| `areas` | `{ commonArea: { id, code, nameEn, nameAr }, before, after }`; a stage is `{ id, recordedAt, note, photos[] }` or `null` |
| `claims` | the damage claims (below), newest first |
| `certificateBlockedBy` | `{ violations, claims }` still open, or `null` when nothing blocks the certificate |

Every write below answers the whole `FitOutView` again (the gate's `done` answers 204).

## The deposit

The management records it with `POST /staff/deposits`:
- `kind: "finishing_works"`;
- `permitId`: the works permit of the unit it is held for, one deposit per permit.

Errors:
- `permitId` on another kind: **400** `FIELD_NOT_ALLOWED`.
- Another unit's permit, or not a works permit: **400** `INVALID_VALUE`.
- A second deposit for the permit: **400** `DUPLICATE_VALUE`.

The compound's rule is `worksDepositRequired` in `GET`/`PATCH /staff/permit-settings`: on for a compound created from now on, off for the compounds that existed when it shipped. Residents read it in `GET /community/permit-rules`.
- While it is on, approving works with no deposit that holds money is **409 `PERMIT_DEPOSIT_REQUIRED`** (`params.deposit`: its number; no params when none is recorded).
- Refunding that deposit while a damage claim on the permit is open is **409 `DEPOSIT_CLAIM_OPEN`** (`params.claims`).

## Drawings (the household)

- `POST /permits/{id}/drawings` `{ fileId }`: a finalized `permit_drawing` file of the caller's (an image or a PDF, 10 MB).
  - Only while the permit is pending, or approved and not ended: **409 `PERMIT_NOT_ACTIVE`**.
  - Ten at once: **409 `PERMIT_DRAWING_LIMIT`** (`params.max`).
- `POST /permits/{id}/drawings/{drawingId}/remove` takes one off, once. A second time is **404 `PERMIT_DRAWING_NOT_FOUND`**.

## Debris removals

| Who | Route |
|---|---|
| the household | `POST /permits/{id}/debris-slots` `{ day, window: { from, to } }` |
| the household (its own) | `POST /permits/{id}/debris-slots/{slotId}/cancel` `{ reasonCode }` |
| `permits.manage` | `POST /staff/unit-permits/{id}/debris-slots`, `…/{slotId}/cancel` (any), `…/{slotId}/done` |
| a guard on shift | `GET /gate/unit-permits/{id}/debris-slots` (today's), `POST /gate/unit-permits/{id}/debris-slots/{slotId}/done` (204) |

- Scheduled on an approved works permit that has not ended:
  - a work day of its period (`day` → `DAY_OUT_OF_RANGE`);
  - inside the compound's hours (`window` → `INVALID_VALUE` with `params.from` and `params.to`);
  - 30 minutes to 4 hours (`window.to` → `INVALID_VALUE`);
  - starting ahead (`window.from` → `INVALID_VALUE`);
  - never overlapping another (`window` → `DUPLICATE_VALUE`);
  - three at once (**409 `DEBRIS_SLOT_LIMIT`**).
- Called off before its window starts, with a code from `debrisSlotCancel`. The household calls off only its own; the management's are **403 `PERMIT_NOT_ALLOWED`** to it.
- Done from half an hour before its window. Earlier, or once done, missed or called off: **409 `DEBRIS_SLOT_CLOSED`** (`params.status`).
- Missed by the system two hours past its window. The requester and the permits' staff get `unit_permit.debris_missed`.

A removal: `{ id, day, window, startsAt, endsAt, status (scheduled | done | missed | cancelled), scheduledSide, doneAt, doneSide (staff | gate), missedAt, cancelledAt, cancelSide, cancelReason }`. Never a person.

## The common areas before and after (the management)

`POST /staff/unit-permits/{id}/area-records` `{ commonAreaId, phase, photoFileIds, note? }`:
- one to ten `fitout_photo` files;
- `before` while the permit is open; `after` on an approved permit, once `before` is recorded (**409 `AREA_RECORD_NO_BEFORE`**);
- once per area and stage (**409 `AREA_RECORD_EXISTS`**, `params.phase`);
- an inactive or unknown area: **400** `commonAreaId` `INVALID_VALUE`.

The household reads the photos and the note in its fit-out.

## Damage claims

| Who | Route |
|---|---|
| `permits.manage` | `POST /staff/unit-permits/{id}/damage-claims` `{ reasonCode, description, amount, commonAreaId?, photoFileIds }` |
| the household | `POST /permits/{id}/damage-claims/{claimId}/appeal` `{ text, photoFileId? }` |
| `permits.manage` | `…/damage-claims/{claimId}/appeal-decision` `{ decision: upheld \| accepted }`, `…/withdraw` `{ reasonCode }`, `…/settle` |

- **Raised** on an approved (or revoked) works permit.
  - A code from `damageClaim`, words up to 1000, EGP up to 1,000,000, one to six `fitout_photo` files.
  - The requester and the primary get `unit_permit.damage_claimed` (`params.claimNumber`, `DC-0001`).
- **Appealed** once, within 14 days (`appealUntil`), while open. Otherwise **409 `DAMAGE_CLAIM_NO_APPEAL`** (`params.status`, `appealed`, `appealUntil`).
  - The photo is a `damage_appeal_photo` file of the caller's. The permits' staff are told.
- **Decided:** `upheld` (the claim is open again) or `accepted` (withdrawn, `appeal_accepted`). The appellant is told.
- **Withdrawn:** open and not under appeal, with a code from `damageClaimWithdraw` but `appeal_accepted`. The household is told.
- **Settled:** open, once its appeal was decided or its 14 days passed (**409 `DAMAGE_CLAIM_APPEAL_WINDOW`**), with a fresh step-up (`STEP_UP_REQUIRED`).
  - The works deposit gives what it holds; the rest becomes a `damage` invoice of the unit's, due in 14 days.
  - The household is told (`unit_permit.damage_settled`).
- A claim in the wrong state for an action: **409 `DAMAGE_CLAIM_NOT_OPEN`** (`params.status`).

A claim:
- `{ id, number, reasonCode, description, amount, status (open | under_appeal | withdrawn | settled), commonArea, raisedAt, appealUntil, photos[] }`;
- `appeal`: `{ text, photo, at, decision, decidedAt }` or `null`. `text` is null after the appellant's erasure.
- `withdrawn`: `{ at, reason }` or `null`;
- `settlement`: `{ at, deducted, charged, invoiceId, chargeStatus }` or `null`.

## The certificate

`POST /staff/permit-inspections/{id}/decide` with `outcome: "passed"` is **409 `WORKS_CERTIFICATE_BLOCKED`** (`params.violations`, `params.claims`) while:
- the permit's violations are open or under appeal; or
- its damage claims are not settled or withdrawn.

`certificateBlockedBy` in the fit-out shows the same counts beforehand.

## The export

A resident's personal-data export gains `permits/fit-out.json`:
- the claims on the works permits they asked for (with their own appeal's words while they last);
- the debris removals they scheduled;
- how many drawings they joined to each permit.
