# 0054 — Children: exit control, authorized escorts, alerts, activities

**Status:** Accepted · Phase R9

## Context

A minor is a household membership without an account (ADR 0016, 0021). Nothing stopped a child leaving the compound with a stranger, and nobody was told. The household also had no way to name its children for the compound's activities.

This ADR adds:
- exit control per minor: a child card, an optional photo, the escorts who may collect the child, and whether the child may leave alone;
- a two-scan flow at the gate, with alerts;
- 30-day records the household reads;
- events for children, and a child named as a booking's occasion.

Out of scope: school bus tracking, vaccinations, parent groups.

The model follows ADR 0044–0052:
- rules are decided under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

**This amends:**
- ADR 0016: a hook when a minor leaves, and a key on members;
- ADR 0031: the one exception to "a resident's movements are never logged";
- ADR 0036: two critical kinds, two file purposes, an export section;
- ADR 0040: events for children;
- ADR 0044: a child as a booking's occasion.

## Decisions

### Where it lives

- **`src/gate/children`.** The gate domain may import the community, and the guard's side of the feature is the gate's.
- **The household's routes are under `/units/{unitId}/children`.** This is the same arrangement as emergencies (ADR 0047).
- **`CommunityGatePort` gains:**
  - `minors`, `minorOf` (FOR SHARE) and `minorsById`;
  - `assertHouseholdMutable`;
  - `requireHousehold`, which now returns the primary a delegate acts for.

### A minor leaving, told to the domains (amends ADR 0016)

A minor has no account, so no account hook fired when their membership ended or the same member row came of age.

- **`AccountLifecycle.onMinorLeaving({ memberId, unitId, cause: membership_ended | came_of_age })`.**
  - `endMembership` calls it after the status write, for every minor. That covers a removal, a rejection, the household's end and a transfer.
  - The majority invite's acceptance calls it **before** the `is_minor` flip, under the unit lock it already holds. It runs the handlers' after-commit work once the acceptance commits.
- **A new unique key `household_members (tenant_id, id, unit_id, is_minor)`.** A control names "this minor of this unit" with one composite key, `ON UPDATE CASCADE`. Member grants do the same with `(tenant_id, id, is_minor)`.

### Exit control

**Who may:**
- The primary or a `household` delegate turns it on for one of the unit's minors. The child must be under 18 by the compound's day; anything else is 404 `CHILD_NOT_FOUND`.
- It is decided under the unit's row lock. One live control per child (409 `CHILD_CONTROL_ACTIVE`), backed by a partial unique index.
- The household adults read it: `gateEntry` on the unit (ADR 0031), meaning residing occupants and adult members with an account. A landlord gets 403 `NOT_A_RESIDENT`. The management gets 403 by permission. Another unit is 404.

**The switches:**
- `mayLeaveAlone`.
- `notifyPickups`: tell the household of each exit. It is per child, not per household.

**Under a death review (ADR 0021):**
- Turning it on and letting a child leave alone wait (403 `HOUSEHOLD_UNDER_REVIEW`).
- Tightening, revoking and turning off never wait.

**The child card is `JWC1.<token>`.**
- The token is 256 random bits.
- It is answered once, at turn-on and at a reissue. `Idempotency-Key` is claimed but no body is stored, so a replay prints another card.
- **Only `hex(SHA-256("jiwar:child-card:v1:<tenant>:<token>"))` is kept, with no pepper and no key.** A card is printed and lives for years, and rotating `IDENTIFIER_PEPPER` must never kill every printed card. The label keeps it apart from every other hash, and the compound makes another compound's card unknown.
- A reissue replaces the hash, so the old card stops scanning in that transaction.
- Test vector:
  - tenant `01a102b6-6253-74a0-92b1-96e7c9d52601`
  - token `q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek`
  - hash `2c74d8b9cfe5563fd20d0eab68e87c05e3cf6e86720d164659e7fba8ac5055f6`

  The unit test `child-tokens.spec.ts` pins it.

**The child's photo:**
- New file purpose `child_photo` (images, 5 MB, uploaded by `household.manage`).
- Set, replaced and removed by the household.
- Shown to the household adults and to a guard checking the child.

**A control ends once.** One row is one period of control; turning it on again is a new row.

| Reason | When |
|---|---|
| `household` | the household turns it off |
| `left_household` | the child's membership ends (`onMinorLeaving`, in that transaction) |
| `came_of_age` | the same member row comes of age (`onMinorLeaving`), or the 18th birthday by the compound's day (sweep `gate.child_majority`, hourly) |

- The sweep handles one control per transaction, taken FOR UPDATE SKIP LOCKED and judged again under the lock. Until it runs, the gate already treats the card as unknown.
- **The end kills the card, deletes the photo, and revokes every live escort** (`control_off`).

**`child_controls`:**
- the card and the photo exist exactly while the control is live (CHECKs);
- a trigger keeps whose control it is, ends it once, and freezes it after;
- a new card needs a later issue time;
- never deleted.
- **A live control on an adult is impossible.** `member_is_minor` follows the member row (`ON UPDATE CASCADE`) and a CHECK refuses it while live. A coming of age that did not end the control first fails.

### Escorts

**Three kinds, at most ten live per child (409 `CHILD_ESCORT_LIMIT_REACHED`):**
- `adult`: an account that lives in the unit (`gateEntry`).
- `worker`: one of the unit's engagements, active, not banned, not past its end.
- `outside`: a name (1–80), an E.164 phone and an optional photo. New purpose `child_escort_photo`.
- Anyone else is the field error `ESCORT_NOT_ELIGIBLE`. One live escort per person and child (409 `CHILD_ESCORT_DUPLICATE`).

**Validity:**
- a first day (today or later);
- a last day, or open-ended;
- weekly hours in the compound's zone, or any time;
- a post (a gate, or a zone in service), or anywhere.

The "compound zone" of the request is a post. The verdicts come from pure functions (`child-rules.ts`, with a spec).

**Who manages them:**
- The primary or a `household` delegate adds, changes, reissues and revokes them, under the unit's row and the control's lock.
- Adding and changing wait under a death review; revoking never does.
- The household adults list them.

**An outside person's pickup code is answered once, at creation and at a reissue:**
- a QR `JWP1.<token>`;
- a 6-digit code derived from the token (`AccessTokens.issue`, drawn again on a collision among the compound's live pickup codes);
- the link `<PUBLIC_APP_URL>/c#<token>`.

Only HMACs are kept, with labels of their own: `child-pickup-code:<tenant>:<code>`, `child-pickup-qr:<tenant>:<token>`, and the global pointer `child_pickup_links` (`child-pickup-link:<token>`, on the RLS allowlist, no PII). A lost link means a reissue: the code is not readable again (unlike a visitor's, ADR 0043).

**The pickup page is `POST /public/child-pickups/lookup`,** the visitor page's twin:
- the same rate limits (under `child-pickup-page:` keys) and headers;
- one 404 `CHILD_PICKUP_NOT_FOUND` for every token that is not a live link;
- the compound, the unit, the days, hours and post;
- `status` is `active`, `not_yet` or `expired`, and the code and QR come only while it is `active`;
- **never the child's, the household's, the escort's or anyone's name.**

**A revocation:**
- by the household (`household`);
- by the control ending (`control_off`);
- or for an adult who stops living there, is deactivated or is erased (`left_household`). The account hooks hold the account first and take the control after it.

It kills the code, the QR and the link and deletes the photo. The name and phone of an outside person stay for the household's 30-day records, and are cleared 30 days after the revocation. A worker whose engagement ends is left inert; the gate checks the engagement at every scan.

**`child_escorts`:** shape CHECKs by kind; the code exactly while an outside escort is live; live codes unique per compound. A trigger keeps who and for which child, revokes once, and then only clears the name and phone, once. Never deleted.

### At the gate

These are the gate's own endpoints, apart from `/gate/verify`, for a guard on shift at a gate or a zone. They share `/gate/verify`'s per-guard rate-limit budget.

**`POST /gate/children/verify {card}`:**
- the child's first name and photo;
- whether they may leave alone;
- the escorts who may collect them today: first names, photos (an adult's own, a worker's, an outside person's) and whether now and here;
- **it writes nothing**;
- anything that is not a live card of this compound, of a child under 18, is one 404 `CHILD_CARD_UNKNOWN`.

**`POST /gate/children/exits {card, escort: {qr} | {code} | {alone} | {unidentified}}`:**
- `qr` is a resident's entry QR, a worker's card or a pickup QR. `code` is a worker's 8 digits or a pickup code's 6.
- A credential nobody can be told from is 422 `CHILD_ESCORT_UNKNOWN` and records nothing, so a mistyped code never raises an alarm. A person with nothing to scan is recorded as `unidentified`.

| Outcome | When | Who is told |
|---|---|---|
| `picked_up` | an escort of this child, valid now and here, still eligible | the household adults, `child.picked_up {outcome}`, if `notifyPickups` |
| `left_alone` | alone, with leave | the same |
| `refused` | a known person who is not this child's escort (`not_an_escort`); an escort outside their days or hours (`outside_validity`), at another post (`wrong_post`), no longer eligible or revoked under the lock (`escort_inactive`); the unidentified (`no_credential`) | **the household adults and the roster's keepers, `child.unauthorized_pickup`, critical** |
| `alone_refused` | alone, without leave (`alone_not_allowed`) | the household adults, `child.exit_alone`, critical |

- All three kinds are in the `household` category, with ids only and never the guard who recorded the exit.
- The keepers are `guard_roster.manage` holders: the security supervisor and the manager.

**Lock order of an exit:**
1. The guard's account and open shift, FOR SHARE.
2. The credential, resolved with plain reads.
3. The accounts that may be told (the household adults and the keepers), FOR KEY SHARE in id order. This is the lock a notification's row would take.
4. The child's control, FOR UPDATE and read again. A reissue or an end that won it leaves an unknown card.
5. The escort, FOR SHARE.
6. Eligibility, read again plainly.

**No account row and no unit row is locked after the control.** The hooks that revoke an escort (deactivation, erasure, leaving) hold the account first and take the control after it. Before step 3 existed, a deactivation holding an escort's account could wait on the control while the exit, holding the control, waited on that account for its notification: a deadlock. A test now races both orders.

**Two exits of one child at once serialize on the control.** Within five minutes of an authorized exit, the same escort replays it (200) and anyone else is 409 `CHILD_JUST_PICKED_UP`. A refused attempt never blocks a valid one right after it. The resident's entry is never logged, so whether a child is "outside" cannot be known; the window is the duplicate guard.

### The records (amends ADR 0031)

`child_pickups` is **the one exception to "a resident's movements are never logged"**, and only for children whose exit control is on.

- Each exit records the outcome, the method, the reason, the escort, the guard, the shift and the post, at the database's clock.
- Append-only (UPDATE and TRUNCATE refused for everyone).
- **Deleted 30 days after it was made** by the sweep `gate.child_records_purge`, hourly. The same sweep clears the name and phone of an outside escort revoked 30 days ago.
- **Readers:**
  - the household adults read their children's records (`GET /units/{unitId}/children/pickups`);
  - the roster's keepers read the **unauthorized pickups only, without the child** (`GET /staff/security/child-alerts`, `…/{id}`: when, the post, the guard by first name, the unit, the method, the reason);
  - nobody else reads any.
- **The audit trail names the record and its codes only** (`child_pickup.recorded`: outcome, method, reason). It never names the child, the control, the unit or the escort, so the permanent trail holds no child's movements once the record is gone. The purge is audited by count.

### Events for children (amends ADR 0040)

- **An event may be for children of an age range,** 0 to 17 in order, fixed once written (`community_events_children`).
- **Registering a child:** `PUT /events/{id}/children/{memberId}` (`community.read` + `household.manage`).
  - The unit's primary or a `household` delegate (`CommunityEngagementPort.requireHousehold`), before the start.
  - The child must be of the ages on the event's local start day (409 `COMMUNITY_EVENT_AGE_MISMATCH`, with the range), and the event must be for children (409 `COMMUNITY_EVENT_NOT_FOR_CHILDREN`).
  - Again is a no-op. `DELETE` takes it back.
- **A registration is a seat, counted with the answers under the event's row lock.** The last seat goes to one registration or one answer, and the other is `COMMUNITY_EVENT_FULL`. The capacity never drops below the children registered.
- **What each reader sees:**
  - counts gain `children`;
  - a resident's event gains its own `myChildren` (first names);
  - the staff's attendees gain each unit's number of children, never who.
- **Lifecycle:**
  - cancelling also tells whoever registered a child;
  - a child who leaves the household is unregistered from what has not started (`onMinorLeaving`);
  - an erasure deletes what the account registered;
  - the export gains `community/event-children.json`.

### A child as a booking's occasion (amends ADR 0044)

- **A bookable facility may take a child as the occasion of a booking** (a birthday space): `childOccasions`, a rule the staff set, bookable only (CHECK).
- **A booking of it may name one of the booking unit's minors** (`occasionMemberId`, read FOR SHARE).
  - Any other facility: `FIELD_NOT_ALLOWED`.
  - Anyone else: `PERSON_NOT_OF_UNIT`.
- **What each reader sees:**
  - the household's views carry `occasion {memberId, firstName}`, the first name only while the child is still the unit's minor;
  - the staff's carry `childOccasion`, never who.
- The booking keeps its occasion (a trigger).

### Permissions

No new permission:
- the household: `household.manage` plus the primary-or-delegate rule;
- the guards: `gate.operate` on shift;
- the keepers' alerts: `guard_roster.manage`.

### Privacy and audit

- **The child's photo:** the household adults' list and a guard's check. Deleted when the control ends, the child leaves or turns 18.
- **The child's name:**
  - the household's own views;
  - a guard's check shows the first name only;
  - staff views (attendees, bookings, alerts), notifications, audit rows and the pickup page carry none.
  - The PII scan proves it with a sentinel child and escort.
- **An outside escort's name and phone:** the household only. A guard sees a first name and a photo, never the phone.
- **Audit:** ids, codes, switches and validity by value. An escort's name, phone and photo, and a child's photo, as changed. Never a card, a code, a hash or a file id.
  - Actions: `child_control.turned_on`, `.updated`, `.card_reissued`, `.photo_changed`, `.ended`; `child_escort.added`, `.updated`, `.revoked`, `.code_reissued`, `.pii_cleared`; `child_pickup.recorded`, `.purged`; `community_event.child_registered`, `.child_unregistered`.
- **Export `children/`:** the controls the account turned on (the child by first name, the switches) and the escorts it added. The exits are not exported: they are the household's records, not the account's. **This amends ADR 0036**, with two more critical kinds (`child.unauthorized_pickup`, `child.exit_alone`) and two file purposes.

## Consequences

- **Migrations `20261101090000` to `20261101090700`:**
  - the member key;
  - the two purposes (the enum values alone, then both file CHECKs recreated);
  - controls, escorts with the global pointer, and pickups;
  - events for children, and the booking occasion.
- **The manager dashboard gains:** Security > Child alerts, "for children" in the events composer, and the facility's "children's occasions".
- **The guard app scans two QRs per exit.** The household app shows the card once (print it), the escorts, and the 30-day records. See `docs/api/notes/children.md`.
- **After G6b's lockdown lands,** a lockdown refuses an outside escort, recorded and told to the household.

## Open

- **Separation (ADR 0021) changes nothing for children here.** Custody is a legal matter the backend cannot judge; the management has no override for a child's escorts.
- **A worker escort whose engagement ends stays listed until the household revokes it.** The gate refuses them (`escort_inactive`).
- **A child "outside" is not tracked.** Only exits are recorded, never returns.
