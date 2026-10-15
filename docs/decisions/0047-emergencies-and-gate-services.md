# 0047 — Emergencies and gate services: a critical alarm to every guard on shift with escalation to the management, the family told and on its way, the gate's phone instead of anyone's own, and one table of what residents ask security for

**Status:** Accepted · Phase G6a · Gate card (emergencies and gate services, parts C and D)

## Context

The mobile team builds the Gate card's last two parts on top of ADR 0043 and 0045:
- an emergency button that brings security (C1–C3), the unit's emergency contacts (C4) and accessibility help (C7);
- what a resident asks security for: a suspicious-activity report, an escort and a lane at a gate (D1–D3), from the compound's places (D4), and the list of their requests (D5).

Security needed a queue to answer from, the management a live view and a way to know when nobody answered.

Out of scope: the clinic and children's vaccinations (C5, C6; the mobile app hides them), incident reports and investigations (G6b), positions and maps (no GPS).

The model follows ADR 0044 and 0045:
- rules are checked under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### In the gate domain

`src/gate/emergencies`, `src/gate/gate-services`, `src/gate/places` and `src/gate/safety` (what they share). The community is read through `CommunityGatePort`, which gains:
- `residents`: who lives in a unit, and as what;
- `unitLocations`: a unit's code and building;
- `isActiveMember` and `memberFirstNames`: household members.

### Places

- Every compound starts with the seven places of the mobile contract (`main_gate`, `north_gate`, `phase_a`, `phase_b`, `clubhouse`, `parking`, `other`). Each is known by `key`, so the app names it in its own words, and has English and Arabic names. Existing compounds got them from the migration.
- The manager (`gate.manage`) renames, orders, retires and restores them, and adds places of their own (no key).
- **A place is never deleted:** requests point at it. It keeps its key (a trigger).
- Two places in service never share a name, in either language.
- `GET /community/places` lists those in service, for residents and responders.
- A request may name a place only while it is in service. It is read FOR SHARE, so a retirement waits for the request.

### Phones

- **Gates already had a phone** (ADR 0043).
- The compound's settings gain the office phone and the duty phone, E.164, set by the manager and audited as changed. The existing emergency number stays as it is (the visitor page, the worker card).
- **Nobody's own phone is ever given for a responder.** A responder is shown by first name and a phone:
  - the phone of the gate of their open shift;
  - for someone not at a gate, or a gate without a phone, the duty phone, else the emergency number.

### Emergency contacts (C4)

`GET /units/{unitId}/emergency-contacts`, for anyone the unit gives the emergency button:
- **family:** the other people who live in the unit (residing occupants and active adult members with an account; the primary first), with their name, role and phone. Only for a caller who lives there too: a landlord gets none. Minors without an account are not listed;
- **gates:** the gates in service that have a phone;
- **management:** the office, the duty manager and the emergency number, each when set, named by role.

This is the one place where people who live together see each other's phones. The PII scan allows exactly that.

### Emergencies (C1–C3)

**Reporting** (`POST /emergencies {type, unitId}`): anyone the unit gives the emergency button (`capabilities.emergency`, never taken away).
- **Never rate-limited.**
- **One open per unit and type** (reported, on the way or arrived). It is decided under the unit's emergency lock, with a partial unique index behind it. A repeat answers 200 with the open one, including on an `Idempotency-Key` replay (`claim()` takes the status).

**Who is told, at once**
- every guard on an open shift (active, still holding `gate.operate`) and every `emergencies.respond` holder: `emergency.reported`, critical;
- the others who live in the unit: `emergency.family_alert`, critical. The lock-screen text is generic ("Emergency reported from your unit"): no name, no unit. Each is recorded (`emergency_family_alerts`), and their count is `familyNotified`;
- **nobody there to tell:** the management (`emergencies.manage`) gets `emergency.escalated` at once (`no_responders`).

**Escalation:** a sweep every 30 seconds hands any emergency nobody accepted within two minutes to the management, once (`timeout`).
- One transaction per emergency, the row taken with SKIP LOCKED and judged again under its lock: an accept or a cancel holding it wins.
- Escalated, it can still be accepted.
- The escalation is audited with how many were told, none included.

**Responders** (`/gate/emergencies`): a guard inside an open shift, an `emergencies.respond` holder or the management.
- They see every emergency of the compound: the unit, the building, the type and the reporter's first name; never a resident's phone.
- **The first to accept wins**, under the row lock (409 `EMERGENCY_ALREADY_ACCEPTED` for the rest). The responder picks the minutes they expect to take: 2, 5, 10 or 15.
- **There is no GPS.** `minutesAway` counts down from the acceptance: null before it and once closed, 0 once arrived, never below 0.
- The reporter and the family get `emergency.responder_on_the_way`, critical, with the minutes.
- The responder marks the arrival.
- The responder or the management resolves it, with a code (`emergencyResolve`) and a note of their own. The household never sees the note.

**The household** follows it (`GET /emergencies/{id}`, `GET /me/emergencies`): the reporter and those alerted. They see:
- the timeline: `reported`, `security_notified`, `management_notified`, `on_the_way`, `arrived`, a `family_on_the_way` per member with their first name, and `resolved` or `cancelled`;
- the responder's first name and phone;
- the countdown;
- the family counts.

The reporter or the unit's primary cancels an open one, with an optional `emergencyCancel` code. Its responder is told; with none yet, everyone who would answer (and the management, once escalated). All of it is `emergency.cancelled`, critical.

**"On my way"** (`POST /emergencies/{id}/on-my-way`): an alerted member, once, while it is open.

**The row** moves forward only (a trigger):
- who reported what, where and when never changes;
- it is accepted, arrived at, escalated and closed once each;
- a closed one never changes again;
- it is never deleted.

### Gate service requests (C7, D1–D3, D5)

**One table, `gate_service_requests`, with a kind.** What each kind carries is held by a CHECK:
- **accessibility:** a wheelchair, someone to walk with, a golf cart or bags, for the requester or an active household member, from a place to a place or home, now or in 15 or 30 minutes (`wanted_at`). Numbered `A-`;
- **suspicious:** a place, the resident's words, a photo (`gate_service_photo`). Numbered `S-`;
- **escort:** from a place to a place, when. Numbered `S-`;
- **lane:** an ambulance, a fire truck, a moving truck or a large delivery, at a gate in service, with notes. Numbered `S-`.

**Who may ask**
- Someone who lives in the unit (`capabilities.gateEntry`). A landlord is refused (`GATE_SERVICE_NOT_ALLOWED`); another unit is not found.
- **Limits, under the unit's lock:** three open per kind and twenty a day per unit (`GATE_SERVICE_LIMIT_REACHED`, with the scope).

**Who is told:** the guards on shift (at the lane's gate first, else at every gate) and the `gate_services.handle` holders, with `gate_service.requested`, critical. It is staff work, like a ticket assigned (ADR 0036).

**Statuses:** open → accepted → in_progress → closed, or cancelled.
- The requester cancels while it is open.
- The system cancels when the requester is deactivated or erased (`requester_left`).

**Handling** (`/gate/gate-services`, a guard inside a shift or a `gate_services.handle` holder):
- **accept:** the first wins. Minutes are required for help that comes to someone;
- **start:** the handler only;
- **close:** with a code (`gateServiceClose`) and a note of their own. An open request may be closed by anyone there (a duplicate); an accepted one by its handler or a `gate_services.handle` holder.

The requester is told of the acceptance and the close (`gate_service.accepted`, `gate_service.closed`, not critical). They see:
- the handler's first name and the gate's phone;
- the countdown;
- never the note.

**The row:** a trigger keeps what it asks, moves it forward only and records each handling step once. Once over, it changes no more, except that an erasure may clear the resident's words.

### Permissions and roles

| Permission | Who holds it |
|---|---|
| `emergencies.report` | residents and family |
| `gate_services.request` | residents and family |
| `emergencies.respond` | staff or manager; no default role (a compound's control room) |
| `emergencies.manage` | the manager role: the live view, escalations, answering and resolving any |
| `gate_services.handle` | staff or manager; the manager role |

- The guard role is unchanged: `gate.operate` inside a shift is enough to respond and handle.
- `pnpm access:sync` brings existing compounds the grants.

### Notifications

A new category, `safety`. Params are a type, a kind, minutes or a reason's code at most: never a name, a unit or a plate.

| Kind | Who is told | Critical |
|---|---|---|
| `emergency.reported` | guards on shift and responders | yes |
| `emergency.family_alert` | the others who live in the unit | yes |
| `emergency.escalated` | the management | yes |
| `emergency.responder_on_the_way` | the reporter and the family | yes |
| `emergency.cancelled` | the responder, or those who would answer | yes |
| `gate_service.requested` | guards on shift (the lane's gate first) and handlers | yes |
| `gate_service.accepted` | the requester | no |
| `gate_service.closed` | the requester | no |

Each has its English and Arabic push text, generic.

### Privacy and audit

**Audit rows** carry ids, codes, statuses, minutes and counts.
- A place's names only as changed.
- The phones only as changed.
- Never the words of a report, a lane's notes or a staff's note (a boolean says whether there was one).

**Deactivated or erased:** the account's requests that are not over are cancelled by the system.

**Erased:**
- what it wrote and its photo go, once, together (`text_cleared_at`, audited);
- security's notes stay;
- emergencies hold no words of the household's and stay as they are, pointing at the tombstone.

**Export** (`safety/`):
- the emergencies the account reported;
- for those it was only alerted to: codes and times with its own "on my way", never who reported or responded;
- its requests with its words while they last, and whether there is a photo (the request's file, not the account's: ADR 0036).

### The plate key folds the letter variants

ADR 0045 left them unfolded. A guard typing ا for a sticker's أ missed the car. `plate_key` and `plateKey()` now also read:
- أ, إ and آ as ا;
- ى as ي;
- ة as ه.

Both use the same two strings. A test feeds both the same plates, and another checks the strings map character for character.

The migration first checks, compound by compound, that no two active permits fold to one plate. If some do, it stops with their count, and the management voids one permit and deploys again. Nothing is chosen for them.

## Consequences

- **Migrations** (`20261025090000` to `20261025090600`):
  - the plate fold;
  - the enum values alone (the `safety` category and `gate_service_photo`), then the size CHECK with the new purpose;
  - places;
  - the management's phones;
  - emergencies (with the counters and family alerts);
  - gate service requests.
- **Five new tenant tables**, each under RLS, forced, with composite keys. Every new CHECK is reviewed in the CHECK map. Nothing here is deleted by the app; triggers guard every row.
- **This amends ADR 0036:** a twelfth delivery category, `safety`; a `safety` export section; six more critical kinds.
- **This amends ADR 0045:** the plate key folds the Arabic letter variants (its "Open" line).
- **The manager dashboard gains:**
  - Emergencies (live, every ten seconds);
  - Gate services (the queue);
  - Gate > Places;
  - the office and duty phones in Settings.

  An account holding only one of the new staff permissions may sign in.

## Open

- **No live channel:** the apps and the dashboard poll. Pushes are the alarm.
- **No GPS, no map:** minutes are the responder's word.
- **A responder who leaves mid-way** (shift ended, account gone) stays the responder; the management resolves it, or the household cancels and reports again.
- **A shift started after a report** is not pushed the open emergencies; the guard sees them in the queue, and the escalation covers the gap.
- **Emergencies are not rate-limited by design:** the one-open-per-type rule is the only brake.
- **The clinic** (C5, C6) is not built.
