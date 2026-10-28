# 0063 — Moving in and out with a checklist per move; the closed unit fixed and open to the owner of a vacant unit; unit proxies an owner trusts while the unit is closed; a closed unit's inspection requests and reports; works completion and its certificate

**Status:** Accepted · Phase R11a-2 · The resident's unit

## Context

ADR 0062 (R11a-1) put the resident's unit on paper. This record covers the rest of the 10-21 audit's unit lifecycle:
- moving in and out, and what must be done each way;
- the closed unit (ADR 0020): its bugs, and a vacant unit nobody could close;
- someone to look after a closed unit;
- the owner's view of its inspections;
- finished works, and a certificate that says so.

It answers R8-1, R8-3 and R8-7 (ADR 0062's table).

The model is the earlier cards':
- rules are decided under a lock, by the database's clock (`dbNow`), with days on the compound's calendar;
- rows move forward only (triggers);
- codes replace free text where someone else reads it;
- every new table is under RLS, forced, with composite foreign keys;
- the audit, notifications, outbox and idempotency hold ids, codes and counts only.

## Decisions

### Moves (`unit_moves`, `MV-`)

**A move belongs to an occupancy.** It has a direction (`in` or `out`) and a planned day, and is `planned`, then `done` or `cancelled` once (trigger). Each occupancy has at most one planned move each way.
- **A move-in** is planned for today when a residing occupancy begins: every creation path passes through `recordCreated`. The management confirms it.
- **A move-out** is the residing primary's notice (never a delegate's; R8-7), or the management's. It is done at the occupancy's **handover**, in the same transaction.
- **The handover is never blocked** (R8-3: keys are physical). When the move-out's checklist has no clearance, the manager gives a code from `REASON_CODES.handoverWithoutClearance` (`MOVE_HANDOVER_REASON_REQUIRED` otherwise).
- **An occupancy that ends** cancels its planned move-in (`occupancy_ended`).
- **Cancelling.** The resident withdraws only the notice they gave; the management cancels any move. Both give a code from `REASON_CODES.moveCancel`.

**The checklist** is a closed list per direction (`move-checklist.ts`).
- **Manual steps** are ticked once by their side:
  - the resident reads the moving guide;
  - the management hands or takes the keys, reads the meters, inspects the unit.
- **Derived steps** are read, never stored, through a new core registry, **`MoveSteps`**:
  - the move permit (gate);
  - the mover's request on the topic `utilities` (management);
  - a clearance since the notice, and the deposits holding nothing (finance).

  Community cannot import those domains, so each registers its reader at startup, and a missing reader stops the start.

**A move permit says which way it goes** (`move_direction`, required) and serves the unit's move planned that way (`move_id`).
- Permits from before this ADR have no direction. A `legacy_move` mark, true on every existing row and false on every new one, lets the CHECK hold over the whole table, validated.
- A NOT VALID constraint or a date cutoff would have failed ADR 0061's migration check.

**The topics `utilities` and `unit_preparation`** are seeded in every compound (`UNIT_TOPICS`) and backfilled per compound.

### The closed unit (amends ADR 0020)

- **Lock order and clock.** Closing and reopening lock the caller's account before the unit, and read the database's clock.
- **Who may close it:** the owner primary, or **any owner of a unit with no primary** (nobody else could close it). Never a tenant.
- **It ends with the household:** an ownership transfer or the household's end clears it, audited with the reason.
- **Permits on a unit with no primary.** Its owner asks for its permits.

### Unit proxies (`unit_proxies`, a `proxy` account)

**Appointing.** An active owner occupancy, never a delegate, appoints an outside person.
- **Details:** their name, email, phone and identity document, as a household invite takes them.
- **Scopes:** `inspections`, `tickets`, `visitors_invite`, `works`, `requests`.
- **End:** a year at most.
- **Limit:** two live (invited or active) per unit, under the unit's lock.

**Accepting.**
- The owner gets a link once (`/x#<token>`) and shares it.
- The person receives a code at that email: a new OTP purpose, `proxy_accept`, with its own text.
- They accept into their own **`proxy` account**, a fifth separate capacity (ADR 0002), with the default role `unit_proxy`.
- That account comes only from an accepted invite: `POST /accounts` takes the four other capacities alone.
- The invite's personal data goes at acceptance or at the end, and its link's global pointer goes with it.

**Acting.** A proxy acts **only while the unit is closed or has no primary**:
- a capabilities subject `proxy` gives the unit's view, tickets and visitors by scope, and nothing else;
- works permits, on behalf of the owner who appointed it (`works`);
- requests to the management (`requests`);
- inspections (`inspections`).

Never money, contracts, documents, governance, the household, closed mode, moves or events.

**Ending.** A proxy ends once:
- an owner revokes it;
- it expires, or its invite goes unanswered for seven days (a sweep);
- the household ends, or the ownership is transferred;
- the owner occupancy that appointed it ends;
- its account is erased.

### Inspection requests and reports (amends ADR 0050)

**Asking.** An active owner of a **closed** unit, or its proxy with `inspections`, asks for a guard's visit on a preferred day. A request's reference is `IR-` and a number.
- One live request per unit, under an advisory lock per unit, after the caller's account.
- The holders of `guard_tasks.manage` are told.

**Scheduling.** The management schedules it as a closed-unit inspection task that names the request (`requestId` on the task create).
- The task's completion marks the request done and tells its asker too: a unit with no primary has nobody else.
- The task's cancellation cancels the request.
- Either side cancels an open request with a code.

**Reports.** The same people read the unit's inspections: when, the outcome, the guard's note and photos (presigned, `no-store`), **never the guard's name**. ADR 0050 kept the photos for the staff alone.

### Works completion (`permit_inspections`, `WC-`)

**Asking.** The requester of an **approved works permit** asks for the finished works to be inspected.
- One inspection is open per permit, under the unit's lock.
- A composite key on the permit's kind keeps it to works.

**Deciding.** The management (`permits.manage`) decides once, with one to five photos (`works_inspection_photo`).
- **Failed:** findings from `REASON_CODES.worksFinding`. The requester fixes them and asks again: a new cycle.
- **Passed:** issues the **completion certificate**:
  - a number;
  - a verify code on the row, as receipts and clearances keep theirs;
  - the template (`certificate.v2`, ADR 0062's renderer);
  - a global pointer for the public check.

A permit passes once. The PDF is drawn on demand, for the requester and the management, and never cached.

**A finishing-works deposit** (ADR 0062) reads the completion through a second core registry, **`WorksCompletions`**: finance cannot import the gate, so the gate registers its one reader at startup, and a missing reader stops the start.
- The reader returns the newest passed completion of a works permit of the unit, since the deposit was received.
- The deposit's view gains `worksCompletion` (when, and the certificate's number), for the depositor's refund ask and the manager's settlement.
- The refund stays the manager's decision.

**The public check** is `POST /public/works-certificates/lookup` (`/w` in `apps/public`).
- It shows the compound, the number, the unit's code and the day; no person.
- It is rate-limited per IP, and every miss gets the one 404.

### The resident's lists and the export (amends ADR 0058 and ADR 0036)

**`/me/requests` and `/me/search`** (ADR 0058) carry two new types, each with its own route's visibility:
- **`inspection_request`:** the requests of the units the caller owns or looks after with `inspections`, and those it asked. Found by `IR-`. Finished when done or cancelled.
- **`works_inspection`:** the rounds of the permits the caller asked for. Found by the certificate's `WC-` once passed. Finished when passed or failed.

**A personal-data export** (ADR 0036) carries the unit's papers, from ADR 0062 and this ADR, as records: never files, and never another person's details.

| File | What it holds |
|---|---|
| `contracts.json` | the contracts the account is a party to |
| `unit-documents.json` | the vault documents it uploaded, and its occupancies' private ones (metadata) |
| `registrations.json` | its registration still kept |
| `moves.json` | its occupancies' moves, with the steps ticked |
| `proxies.json` | the proxies it appointed and the places it holds |
| `clearances.json` | its clearances |
| `deposits.json` | the deposits held for its occupancies |
| `inspection-requests.json` | the inspections it asked for |

### Permissions and roles

| Change | Detail |
|---|---|
| New role `unit_proxy` (kind `proxy`, kind default) | `units.read`, `community.read`, `visitors.invite`, `tickets.create`, `requests.create`, `permits.request` |
| Those six permissions | now also of kind `proxy` |
| `residents.manage` | moves |
| `guard_tasks.manage` | inspection requests |
| `permits.manage` | works inspections |

There are no new permissions. Existing compounds get the role with `access:sync`.

### Privacy and audit

**Audit actions:**
- `unit_move.*`
- `unit_proxy.*` (never the invitee's details)
- `unit_inspection.*`
- `permit_inspection.*`

**Notifications:**
- `unit_move.notice_given` (managers)
- `unit_inspection.requested` (security)
- `permit_inspection.requested` (managers)
- `permit_inspection.decided` (the requester)

Their parameters are a day, a cycle or an outcome.

## Consequences

**Migrations** (`20261120090000` to `20261120090500`):
- `090000`: moves, their steps, the permit's direction (with `legacy_move` and the replaced permit trigger), and the `utilities` topic;
- `090100`: the values `account_type.proxy` and `otp_purpose.proxy_accept`, alone;
- `090200`: proxies and their global invite pointer;
- `090300`: inspection requests, the task's `request_id` (the task trigger replaced), and the `unit_preparation` topic;
- `090400`: the value `file_purpose.works_inspection_photo`, alone (an image, 10 MB: neither files CHECK changes);
- `090500`: completion inspections, their photos, and the certificates' global pointer.

**New core registries:**
- `MoveSteps`, for a move's derived steps;
- `WorksCompletions`, for a finishing deposit.

**New tables:**
- **Six tenant tables**, under RLS, forced, with the UPDATE grant where they are locked.
- **Two global tables** on the allowlist, reached through `GlobalDbService` only.

**This amends:**
- **ADR 0002:** a fifth capacity, `proxy`;
- **ADR 0020:** closed mode;
- **ADR 0049:** a move permit's direction, and the owner of a unit with no primary;
- **ADR 0050:** inspection requests, and the reports' photos to the owners;
- **ADR 0062:** the moving guide is read by the move-in's checklist.

**The manager dashboard gains:**
- Moves, and the handover's code;
- Inspection requests;
- Works inspections;
- a unit's proxies, read only.

**`apps/public` gains** `/x` and `/w`.

**The files CHECKs are M1-1's** (`20261201090100`, ADR 0064). R11a-2 does not recreate them: a works inspection photo is an image of 10 MB, which both CHECKs already allow (their image and size defaults).

**migrate-with-data** seeds a move and a works permit, an inspection task and, in one compound, a `utilities` topic of its own, which these migrations carry over.

## Deviations from the approved plan

- **The utilities step reads a request on the topic `utilities`,** by the mover, about the unit, since the move was planned. It does not use `about=unit_move`, which is the release request's alone (`HOLD_TYPES`, its CHECK and its topic).
- **"A CHECK on new rows" became the `legacy_move` mark.** ADR 0061 refuses an unvalidated constraint.
- **The proxy's link is given to the owner once and shared by them,** as a household invite's is. The server emails only the code.
- **A works permit's view does not change.** Its completion is its own resource (`/permits/{id}/completion-inspections`, `…/completion-certificate`).
- **Inspection requests need a closed unit** (the inspection task does). A proxy of an open unit with no primary cannot ask.
- **In an ownership transfer, a proxy may end as `appointer_left`:** the old owner's occupancy ends first.
- **Not built, kept open:**
  - the `requests` delegation scope;
  - proxy notifications.

## Open

- The four items above.
- **Moves have no notifications** to the mover. The app reads the checklist.
