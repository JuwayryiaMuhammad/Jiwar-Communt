# Children: backend notes for the household app and the guard app

What was built for a child's exit control:
- the household turns it on for one of its minors and prints the child's card;
- it names who may collect the child: adults of the home, its workers, or an outside person who gets a personal pickup code;
- at the gate, a guard scans the child's card, then whoever takes the child;
- the household reads its children's exits for 30 days, and is told at once when something is wrong.

Also: events for children, and a child as a booking's occasion.

- The design decisions are in [ADR 0054](../../decisions/0054-children.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`, except the pickup page (public).
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...] }`. Switch on `code` and `fields[].code`, never on `message`.
- **Every response here is `Cache-Control: no-store`.** Never cache a card, a pickup code or a record on the device.
- Days are `YYYY-MM-DD` in the compound's time zone; instants are ISO 8601 UTC.

## Contents

1. [The household app](#the-household-app)
2. [The outside person's page](#the-outside-persons-page)
3. [The guard app](#the-guard-app)
4. [Events and bookings](#events-and-bookings)
5. [Push notifications](#push-notifications)
6. [Errors](#errors)

---

## The household app

Who may:
- The unit's **primary or a household delegate** changes everything here (403 `NOT_PRIMARY_RESIDENT` for anyone else who lives there).
- **The adults who live in the unit** read it.
- A landlord gets 403 `NOT_A_RESIDENT`.

### A child's exit control

- `GET /units/{unitId}/children` lists the unit's minors under 18, each with `control` (or null): the two switches, `cardIssuedAt`, `photoUrl` and `escorts` (how many).
- `POST /units/{unitId}/children/{memberId}/control {mayLeaveAlone, notifyPickups}` turns it on.
  - The answer carries `card { qrPayload, firstName, unitCode, compoundName }` **once**: print it now. Draw the QR from `qrPayload` (`JWC1.<token>`); the server cannot show it again.
  - With the same `Idempotency-Key`, a retry prints a **new** card, and the first one stops working.
- `POST …/control/card` reissues a lost card. The old one stops scanning at once.
- `PATCH …/control {mayLeaveAlone?, notifyPickups?}`.
- `PUT …/control/photo {fileId}` (a finalized `child_photo` upload) and `DELETE …/control/photo`. The photo is shown to the household and to a guard checking the child, and is deleted when the control ends.
- `POST …/control/off` (204): the card, the photo and every escort end at once.

**A control also ends by itself:**
- when the child leaves the household;
- when the same member becomes an adult with an account;
- on the 18th birthday.

### Escorts

- `GET …/control/escorts` lists who may collect the child now. It never returns a code.
- `POST …/control/escorts` adds one. Send exactly one of:
  - `{ kind: 'adult', accountId }`: someone who lives in the unit with an account;
  - `{ kind: 'worker', engagementId }`: one of the unit's active workers (a nanny, a driver);
  - `{ kind: 'outside', outside: { fullName, phone, photoFileId? } }`: anyone else. The photo is a `child_escort_photo` upload.
- Validity, all optional:
  - `validFrom`: today by default, never earlier;
  - `validUntil`: open-ended by default;
  - `schedule { days: [0–6], windows: [{from, to}] }`: in the compound's time zone; null means any time;
  - `post { gateId } | { zoneId }`: null means anywhere.
- An outside person's answer carries `pickup { code, qrPayload, link }` **once**. Send them the link; the token travels in its fragment (`/c#…`).
  - `POST …/escorts/{id}/reissue` gives a new one, and the old link and code stop at once.
- `PATCH …/escorts/{id}` changes the validity. `POST …/escorts/{id}/revoke` (204) ends it.
- Ten live escorts per child at most.

### The records

`GET /units/{unitId}/children/pickups?memberId=&cursor=` lists the exits of the last 30 days, newest first:
- `outcome`: `picked_up`, `left_alone`, `refused` or `alone_refused`;
- `method`: how the escort was known;
- `refusalReason`;
- `escort { kind, firstName }`;
- the post and the time.

## The outside person's page

`POST /public/child-pickups/lookup { token }` (no account; the token from the link's fragment):
- returns the compound, the unit, `validFrom`, `validUntil`, `schedule`, `post` and `status` (`active`, `not_yet`, `expired`);
- returns `code` and `qrPayload` only while `active`, plus the compound's directions and emergency phone;
- never names the child or anyone else;
- answers one 404 `CHILD_PICKUP_NOT_FOUND` for anything that is not a live link (revoked, reissued, mistyped);
- is rate-limited like the visitor page.

## The guard app

A guard on shift at a gate or a zone (`gate.operate`).

1. **Scan the child's card:** `POST /gate/children/verify { card }`.
   - It returns the child's first name and photo, `mayLeaveAlone`, and `escorts` (who may collect them today, by first name and photo, with `validNow` for this hour and post).
   - It records nothing.
   - Any card that is not live here answers 404 `CHILD_CARD_UNKNOWN`.
2. **Record the exit:** `POST /gate/children/exits { card, escort }` (send an `Idempotency-Key`). `escort` is exactly one of:
   - `{ qr }`: the escort's resident entry QR (`JWR2…`), worker card (`JWR1…`) or pickup QR (`JWP1…`);
   - `{ code }`: a worker's 8 digits or a pickup code's 6;
   - `{ alone: true }`: the child leaves alone;
   - `{ unidentified: true }`: someone with nothing to scan wants to take the child.

   The answer is `{ pickupId, result: 'authorized' | 'refused', outcome, reason, escort }`. **`refused`: hold the child.** The household has been alerted, and the security supervisors too for a pickup.
   - 422 `CHILD_ESCORT_UNKNOWN`: the credential could not be read. Nothing was recorded; scan again, or use `unidentified`.
   - 409 `CHILD_JUST_PICKED_UP`: the child left with someone else within the last minutes.
   - The same escort again replays the exit (200).

Both calls share the guard's scan budget with `/gate/verify`.

## Events and bookings

- **An event for children** has `forChildren`, `childAgeMin` and `childAgeMax`.
  - `PUT /events/{id}/children/{memberId} { unitId? }` registers one of the caller's children (primary or household delegate). `DELETE` takes it back.
  - `counts.children` is how many are registered; `myChildren` lists the caller's units' children by first name.
- **A booking** may name `occasionMemberId` (one of the unit's children) on a facility whose rules have `childOccasions`. The household's booking views carry `occasion { memberId, firstName }`.

## Push notifications

All are in the `household` category. Ids only: open the record by `targetId` (a pickup id).

| Kind | Who | Critical |
|---|---|---|
| `child.unauthorized_pickup` | the adults who live in the unit, and the security supervisors | yes |
| `child.exit_alone` | the adults who live in the unit | yes |
| `child.picked_up` (`outcome`) | the adults who live in the unit, when `notifyPickups` | no |

## Errors

| Code | Status | When |
|---|---|---|
| `CHILD_NOT_FOUND` | 404 | not one of the unit's minors under 18 |
| `CHILD_CONTROL_ACTIVE` | 409 | the control is on already |
| `CHILD_CONTROL_NOT_FOUND` | 404 | the control is not on |
| `CHILD_ESCORT_NOT_FOUND` | 404 | not a live escort of this child (a reissue is for outside escorts only) |
| `CHILD_ESCORT_DUPLICATE` | 409 | that person or worker is already an escort |
| `CHILD_ESCORT_LIMIT_REACHED` | 409 | ten live escorts (`params.max`) |
| `CHILD_PICKUP_NOT_FOUND` | 404 | the pickup page's one answer |
| `CHILD_CARD_UNKNOWN` | 404 | not a live card here |
| `CHILD_ESCORT_UNKNOWN` | 422 | an unreadable credential; nothing recorded |
| `CHILD_JUST_PICKED_UP` | 409 | another exit within `params.minutes` |
| `CHILD_ALERT_NOT_FOUND` | 404 | the keepers' alert does not exist (or is older than 30 days) |
| `COMMUNITY_EVENT_NOT_FOR_CHILDREN` | 409 | a child for an event that is not for children |
| `COMMUNITY_EVENT_AGE_MISMATCH` | 409 | not of the event's ages (`params.min`, `params.max`) |

Field codes:
- `ESCORT_NOT_ELIGIBLE`: not someone who lives in the unit, or not an active engagement of it.
- `PERSON_NOT_OF_UNIT`: a booking's `occasionMemberId` that is not a child of the unit.
