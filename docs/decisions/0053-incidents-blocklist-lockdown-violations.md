# 0053 — Security operations: a guard's SOS from their post, the lockdown of the gates, a blocklist and watchlist met at every plate and ID check, stop work, incidents investigated and acknowledged, violations as the fines, and their reports

**Status:** Accepted · Phase G6b · Gate card (security)

## Context

Since ADR 0047 a household raises an emergency and asks security for a lane; since ADR 0050 guards work posts and shifts, and ADR 0052 gave them patrols. Security still had nothing for:
- a guard in trouble at their own post;
- shutting the gates at once, and opening them again;
- the plates and people the compound refuses, or wants to know about;
- stopping contractors who break the rules of their permit;
- recording what happened, investigating it and closing it;
- fining a unit for what is not a vehicle (noise, waste, pets, contractor hours);
- reports of all of it.

What already exists is reused:
- `SafetyCore` (ADR 0047): the self lock, the holders of a permission, the guards on shift at a post, the safety counters, notifications;
- the shifts and posts (ADR 0050) and the daily report;
- the gate's subjects and entries (ADR 0028, 0049), the plate lookup and its rate limit (ADR 0045, 0049);
- the fines (ADR 0045), as the template for violations and their payments;
- the file flow (ADR 0029), the export sections and the erasure hooks (ADR 0036);
- the shared CSV writer (ADR 0048).

Out of scope: a control room, cameras, fall detection, audio and video, drawn signatures, and anything about children (R9, ADR 0054).

The model follows ADR 0044–0052:
- rules are decided under a lock, by the database's clock;
- rows move forward only, guarded by triggers;
- codes, not free text, outside what people write;
- every response is `no-store`;
- every table is under RLS, forced, with composite foreign keys.

## Decisions

### Lock order

**Everywhere:** the account (FOR SHARE) → the shift → the compound's lockdown state → the compound's blocklist lock → the subject, the permit or the violation → a place or a counter.

- Lockdown starts and ends take the state row FOR UPDATE. The verify, an entry in, a gate request and a material entry take it FOR SHARE, before their subject.
- Blocklist writers take the compound's advisory lock `blocklist:<tenant>` exclusive. Every check takes it shared, after the lockdown row and before the subject.
- Lockdown and blocklist writers take only their own lock and their own rows.

So there is no cycle.

### A guard's SOS

An emergency (ADR 0047) now comes from a unit **or from a guard's post**: the gate or the zone of their open shift.

- `POST /gate/emergencies {type}` (`gate.operate`, on duty at a gate or in a zone).
- **One open per post and type**, decided under the post's emergency lock (`emergency-post:<post>`), with a partial unique index behind it. A repeat answers 200 with the open one; so does an `Idempotency-Key` replay (its own resource).
- **Who is told, at once** (critical `emergency.reported`): the other guards on shift, the `emergencies.respond` holders and the management. Nobody's family. With no responder there, the management gets it as an escalation (`no_responders`), once.
- **Its raiser never accepts it** (403 `EMERGENCY_OWN`). They are told when someone is on the way, and cancel it (`POST …/{id}/cancel`, an `emergencyCancel` code or none). Another guard's SOS is not found.
- The responders' view gains `post`; `location` is null for an SOS. The household's routes never return one.

The schema keeps exactly one origin (`num_nonnulls(unit_id, origin_gate_id, origin_place_id) = 1`). The trigger compares with `IS NOT DISTINCT FROM` and freezes the origin.

### The lockdown

**A guard on shift locks one gate or all down, at once:** `POST /gate/lockdowns {scope: gate | all, gateId?, reasonCode, confirmation: "LOCKDOWN"}`, from a gate or a zone.
- The typed confirmation is the confirm step (product decision: immediate, typed). There is no second request.
- **One live lockdown per scope** (each gate, and every gate): a unique index `NULLS NOT DISTINCT (tenant_id, gate_id) WHERE ended_at IS NULL`. A repeat answers 200 with the live one and tells nobody again.
- A gate's own lockdown under a live "every gate" one is its own row: ending "every gate" keeps it.
- `started_at` is the database's clock after the state row's lock.

**While a lockdown holds a gate, nobody but a resident comes in there:**
- `POST /gate/entries` in, for every subject (visitors, workers, contractors, guests, trucks, gate requests): 409 `LOCKDOWN_ACTIVE` (params.scope). An entry recorded late (ADR 0028) is judged at the instant it happened, so one inside an ended lockdown's window is refused too.
- `POST /gate/verify`: reason `lockdown_active`. Someone inside may still leave, and a resident's QR is valid as before.
- A gate request (the household is never asked) and a material entry in: 409 `LOCKDOWN_ACTIVE`.
- The plate lookup says `lockdown_active` on passes and permits.
- Exits, material exits and residents' own passes are never refused.

**Overrides:** an emergency vehicle through a locked gate. `POST /gate/lockdowns/{id}/overrides` is made by a guard at that gate (409 `LOCKDOWN_NOT_AT_GATE` otherwise), with a `gateLockdownOverride` code (ambulance, fire_truck, police, civil_defense) and the emergency or lane request it answers. It is not an entry (an emergency vehicle has no subject); it is recorded, append-only, and audited.

**Only the management ends one** (`lockdown.end`, the manager only): `POST /staff/security/lockdowns/{id}/end` with a `gateLockdownEnd` code and a note of its own (409 `LOCKDOWN_ENDED` after). `GET /staff/security/lockdowns[/{id}]` lists them with their overrides.

**Who is told:**
- the guards on shift and the `lockdown.end` holders: critical `gate_lockdown.started`, then `gate_lockdown.ended`;
- every active resident (the compound's whole audience, `CommunityGatePort.everyone`): a generic critical `gate_lockdown.resident_notice` when the first lockdown starts, and the end once none is left. It never names a gate or a reason.

**The state row** `gate_lockdown_states` is one per compound, provisioned with the compound and backfilled. It is the serialization row, nothing else.

### The blocklist and the watchlist

**An entry** (`blocklist.manage`) is a plate, or a person:
- a person has a name, the full ID number and an optional face (`blocklist_photo`);
- **the ID number is never stored:** only `hex(HMAC(pepper, "blocklist-id:v1:<tenant>:<number>"))`, after normalizing it (spaces and dashes out, Arabic-Indic digits as Western, letters upper-cased). Nobody sees it again; the create's idempotency record leaves it out and keeps no body;
- `ban` (refused at the gate) or `watch` (let in, the management told), a `blocklistReason` code, a note of the management's own, an optional expiry (at most three years ahead);
- **one live entry per plate key and per ID hash** (409 `DUPLICATE_RESOURCE`, field `plate` or `idNumber`), with a partial unique index behind each;
- `PATCH` changes what a live entry says (kind, reason, note, expiry, face), never its plate or person (a trigger); lift with a `blocklistLift` code, once (409 `BLOCKLIST_ENTRY_LIFTED` after).

**The sweep `gate.blocklist`** (hourly):
- a live entry past its expiry is lifted by the system (`expired`);
- 30 days after a person's entry was lifted or expired, their name, ID hash, face and note go, once (`purged_at`), and the photo is deleted, how many audited. A plate stays, as the fines' do.

**At the gate:** `GET /gate/blocklist` is the active list for a guard on shift: kind, plate or name, face. Never why, the note or an ID.

**Matched wherever a plate or a full ID number is recorded or looked up at the gate**, under the blocklist lock taken shared:

| Where | A ban | A watch |
|---|---|---|
| `POST /gate/entries` in (a pass's or a gate request's visitor plate, an event guest's car, a move's truck) | 409 `ENTRY_BLOCKED` | let in |
| `POST /gate/verify` (a pass's plate) | reason `entry_blocked` | valid; `display.blocklist` names the entry and its kind |
| `POST /gate/approval-requests` (new: `vehiclePlate`, `idNumber`) | 409 `ENTRY_BLOCKED` before the household is asked | asked as any |
| `POST /gate/plate-lookup` (gains `blocklist`) | the plate's passes and permits say `entry_blocked` | flagged |
| `POST /gate/id-lookup {idNumber}` (new) | the live entries: kind, name, face | the same |

- `vehiclePlate` is kept with the visitor's data and purged with it. `idNumber` is matched and never stored, and left out of the idempotency hash.
- The ID lookup is for a guard at a gate, on the guard's own rate limit (the verify's, `GATE_VERIFY_RATE_LIMIT_PER_MINUTE`). It is audited by the entries' ids and how many (`gate.id_lookup`), never the number.
- **A refusal that ends its transaction** records its match and the household's notice in that transaction, which commits without the entry or its `Idempotency-Key`; then 409 `ENTRY_BLOCKED` goes out. A retry asks again.
- **The verify becomes a writer** for the blocklist's matches only (this amends ADR 0028).
- **A resident's pass, move or event guest with a listed plate is made as any.** The match is noted for the keepers, so nothing tells a resident a plate is listed.

**Every match** goes to the keepers' log, `blocklist_matches` (source, outcome refused | flagged | noted, subject, gate, shift, actor; append-only, not audited, like scans), read at `GET /staff/security/blocklist/{id}/matches`. The keepers are told (`blocklist.ban_matched`, `blocklist.watch_matched`, params.source only).

**"Refused by security":** the host whose visitor was refused, or the requester whose guest or truck was, is told once per pass, request, guest or move (`visitor_pass.refused_by_security`, `unit_permit.refused_by_security`; `security_refusals` keeps the once). They are never told why. A visitor pass's detail shows `refusedBySecurity`.

### Stop work

A guard on shift, or the permits' staff, stops the work of an approved works permit in force:
- `POST /gate/unit-permits/{id}/stop-work` and `POST /staff/unit-permits/{id}/stop-work {reasonCode}` (`permitWorkStop`). Not one in force: `PERMIT_NOT_ACTIVE`; stopped already: `PERMIT_WORK_STOPPED`.
- **Its workers are refused at the gate** (`work_stopped`). Someone inside always leaves.
- `POST /staff/unit-permits/{id}/resume-work` (`permits.manage`) lets it go on (`PERMIT_WORK_NOT_STOPPED` otherwise). A revoke or a cancellation ends the stop with the permit (`permit_revoked`, `permit_cancelled`).
- The requester and the unit's primary are told (`unit_permit.work_stopped` with the code, then `work_resumed`); when a guard stopped it, the permits' staff too, so someone may resume it.
- The works views gain `workStopped {since, reasonCode}`.

A stop takes the permit FOR UPDATE; a worker's entry takes it FOR SHARE and reads the stop under it.

### Incidents

**Reported** by a guard on shift (`POST /gate/incidents`) or the management (`POST /staff/security/incidents`, `incidents.manage`):
- a type (`incidentType`), a severity (`incidentSeverity`);
- where: a place in service and/or a unit's code, at least one;
- when: not ahead, at most 30 days back;
- the author's words (1 to 4000), up to five `incident_photo` uploads;
- optional links to an emergency, a gate service request or a patrol note (404 `INCIDENT_LINK_NOT_FOUND`, params.field).

It is numbered `I-`, keeps the guard's shift and post for the daily report, and **never changes as filed**.

**The keepers are told:** `incident.reported` (low to high), or `incident.critical`, a critical push.

**Investigated** (`incidents.manage`):
- assign an investigator, an active `incidents.manage` holder (422 `INVESTIGATOR_NOT_ELIGIBLE`), listed at `GET /staff/security/incidents/investigators`; open → investigating; the investigator is told (`incident.assigned`);
- internal notes (1 to 2000), the management's only, at any status;
- close with an outcome (`incidentOutcome`) and a closing note: final (409 `INCIDENT_CLOSED` for an assign or a close after).

**Acknowledged** by its author and by a reviewer (a keeper who is not the author: 403 `INCIDENT_OWN`), each once, at any status; again answers the same. A close does not wait for them.

**States**, forward only (a trigger): `open → investigating → closed`, or `open → closed`. The investigator may change until it is closed; a closed one changes no more, but for an erasure clearing the closer's words.

**Who sees what:** a guard reads only what they reported, never the investigator, the internal notes or the closing note. **Residents never see incidents**: no resident view, export or notification.

### Violations

**As the fines (ADR 0045), for what is not a vehicle:**
- issued by a guard on shift (`POST /gate/violations`) or the office (`POST /staff/violations`, `violations.issue`);
- a kind (`violationKind`: noise, waste, pets, contractor_hours, other), the unit's code or, for contractor hours, a works permit of the unit (the unit is the permit's);
- a place, the local day (at most 90 days back), a note the unit reads, a `violation_photo`;
- **an amount in EGP, or none: a warning**, which is never paid but may be appealed;
- numbered `V-`; the unit's keepers and its primary are told by the kind alone (`violation.issued`, category `household`).

**The unit's people** (`GET /units/{unitId}/violations`, `GET /violations/{id}`) are its vehicles' keepers and whoever sees its money (`VIOLATIONS_NOT_ALLOWED`). They never see who issued one.

**One appeal** (`POST /violations/{id}/appeal`), by a keeper or the primary (403 `VIOLATION_APPEAL_NOT_ALLOWED`):
- open and never appealed (409 `VIOLATION_APPEAL_CLOSED`), within 30 days of its issue (409 `VIOLATION_APPEAL_WINDOW_PASSED`);
- words (1 to 1000) and a `violation_appeal_photo`.

**Decided and cancelled** by `violations.manage`:
- `POST /staff/violations/{id}/decide-appeal`: upheld, open again; or cancelled (`appeal_accepted`). The appellant is told (`violation.appeal_upheld`, `violation.appeal_accepted`).
- `POST /staff/violations/{id}/cancel`: an open one not under appeal (409 `VIOLATION_NOT_CANCELLABLE`), a `violationCancel` code. Final.

**Paid at the office** (`fines.billing`), exactly as a fine:
- `POST /staff/violations/{id}/payments`: the whole amount (`AMOUNT_MISMATCH`), a receipt once among the compound's violation payments, the local day it was paid (not ahead, at most 90 days back, not before the violation's day: `PAID_ON_OUT_OF_RANGE`);
- `POST /staff/violation-payments/{id}/reverse`: a `violationPaymentReverse` code, once (`VIOLATION_PAYMENT_ALREADY_REVERSED`): open again;
- a warning, a paid or a cancelled one takes no payment (409 `VIOLATION_NOT_PAYABLE`); one under appeal waits for the decision (409 `VIOLATION_UNDER_APPEAL`).

**Statuses:** `open | under_appeal | paid | cancelled`. A violation keeps its terms; the appeal is written once and cleared once; a decision and a cancellation are final; never deleted (a trigger). Payments are append-only; a violation is `paid` exactly while a payment without its reversal holds it.

**Every write takes the violation's row FOR UPDATE**, so an appeal and a payment at once: one wins.

### Reports

**`GET /staff/security/reports/incidents[/export]`** (`incidents.manage` or `guard_reports.read`): per type, in a fixed order with zeros, the incidents that happened on the compound's days asked (a week by default, 31 at most: `PERIOD_TOO_LONG`):
- reported, by guards, by severity;
- open, investigating and closed now;
- the average hours to a close;
- and the totals.

**`GET /staff/security/reports/violations[/export]`** (`violations.manage` or `guard_reports.read`): per kind, the violations of those days:
- issued, by guards, warnings and fined, the amounts issued and paid;
- open, under appeal, paid and cancelled now;
- the appeals and their decisions;
- and the totals.

Counts only, never a name, a unit or a word anyone wrote. One aggregate query each; a rollup gives the totals. The CSVs hold the same rows, the totals last (`all`).

**The daily report (ADR 0050) gains each post's `incidents` and `violations`**: those reported or issued there by a guard on shift that day. The CSV gains them as its last two columns.

### Permissions

| Permission | Who holds it |
|---|---|
| `incidents.manage` | the manager role and the security supervisor: investigate, assign, notes, review, close; the incidents report |
| `blocklist.manage` | the manager role and the security supervisor |
| `violations.manage` | the manager role and the security supervisor: decide appeals, cancel; the violations report |
| `violations.issue` | the manager role: issue from the office |
| `lockdown.end` | the manager role only |
| `gate.operate` | the guards: an SOS, a lockdown and its overrides, the blocklist, an ID lookup, stop work, incidents and violations, inside a shift |
| `fines.billing` | also takes violations' payments |
| `guard_reports.read` | also reads both reports |

`pnpm access:sync` brings the five new permissions to existing compounds.

### Notifications

Params are codes at most: never a plate, a name, a unit, a place or a word.

| Kind | To | Category | Critical |
|---|---|---|---|
| `gate_lockdown.started` · `ended` (`scope`) | the guards on shift, the `lockdown.end` holders | safety | started |
| `gate_lockdown.resident_notice` | every active resident (generic) | safety | yes |
| `blocklist.ban_matched` · `watch_matched` (`source`) | `blocklist.manage` | safety | no |
| `visitor_pass.refused_by_security` · `unit_permit.refused_by_security` | the host, the requester, once | gate_visitors, permits | no |
| `unit_permit.work_stopped` (`reason`) · `work_resumed` | the requester and the primary (and the permits' staff for a guard's stop) | permits | no |
| `incident.reported` (`severity`, `incidentType`) · `incident.critical` (`incidentType`) | `incidents.manage` | safety | critical only |
| `incident.assigned` | the investigator | safety | no |
| `violation.issued` (`violationKind`) · `appeal_upheld` · `appeal_accepted` | the keepers and the primary · the appellant | household | no |

A guard's SOS reuses `emergency.reported`, `escalated` and `cancelled`.

### Privacy and audit

**Audit:** ids, codes and counts; names, notes, descriptions and closing notes as booleans or `{changed}`. Never a plate, an ID number or its hash, a name, or anything anyone wrote. Matches are their own log and not audited.

**The blocklist's name, face and plate** reach only `blocklist.manage` and the guards on duty (the list, the verify and lookup flags). The note and the reason are the keepers' only. The ID number is shown to nobody, ever. The PII scan holds a blocklist persona and treats the ID and its hash as secrets.

**Erased** (consistent with ADR 0050 and 0052: what the account wrote goes, once each, audited by id), in the erasure's transaction:
- the incidents it reported lose their description, and those it closed their closing note (`incident.text_cleared`, which went as booleans);
- its internal notes lose their words (`incident_note.text_cleared`);
- its violation appeals lose their words and photo, the file marked deleted (`violation.appeal_cleared`).

Photos, codes, links, outcomes, acknowledgements, the issuer's note and the decision stay; views show the account erased. **A deactivation changes nothing**: an incident is the compound's (an investigator who left is replaced by assigning another), a violation the unit's.

**Export:**
- `incidents/`: `reported.json` (its reports, its own words while they last, how many photos, status and outcome, never the investigation), `notes.json` (its internal and closing notes), `acknowledgements.json`;
- `violations/violations.json`, as `vehicles/fines.json`: the violations of the units whose violations it sees and those it appealed, its own appeal's words, payments where it sees the unit's money; never who issued one;
- `safety/emergencies.json` names an SOS's post;
- nothing of the blocklist: it is about people who are not accounts.

**Who sees whom:** guards see units by code and building, residents by first name, other guards by first name. Violation and incident views carry no resident's name.

## Consequences

- **Migrations** (`20261031090000` to `20261031090800`):
  - the four file purposes (`incident_photo`, `blocklist_photo`, `violation_photo`, `violation_appeal_photo`) and the safety counter's series `incident` and `violation`, the enum values alone;
  - both file CHECKs recreated with every purpose;
  - emergencies: a nullable unit, the origin columns, one open SOS per post and type;
  - the lockdown state, lockdowns and overrides;
  - blocklist entries; matches and security refusals;
  - permit work stops;
  - incidents, their photos, notes and acknowledgements;
  - unit violations and their payments.
- **Thirteen new tenant tables**, each under RLS, forced, with composite keys. Every CHECK is reviewed in the CHECK map; triggers keep what never changes; nothing is deleted.
- **The races are tested** (×5 rounds, three runs each): two lockdown starts, a start against a verify and an entry, an end against a start (`test/security/lockdown-concurrency`); a ban added against an entry of its plate (`blocklist-concurrency`); an appeal against a payment (`violation-concurrency`); a stop against a worker's entry (`test/permits/concurrency` R10); two SOS at one post (`test/safety/guard-sos`).
- **This amends ADR 0047** (an emergency from a post), **0049** (stop work; the plate lookup's refusals), **0050** (the daily report's two counts), **0028** (the verify writes the blocklist's matches; an offline entry judged against a lockdown's window), **0045** (the plate lookup's blocklist), **0036 and 0029** (two export sections, four file purposes, the erasures).
- **The manager dashboard's Security group** gains Lockdown (with a banner on every page while one is in force), Blocklist, Incidents, Violations and the incidents and violations report; the daily report page shows the two counts; the emergencies page names an SOS by its post.
- **The guard app's notes** are in [`docs/api/notes/security.md`](../api/notes/security.md).

## Open

- **Residents' registered vehicles and domestic workers' stored IDs are not matched** against the blocklist: they are not "at the gate". A banned plate registered as a resident's car is found when it next arrives as a visitor's.
- **Repeated match notifications are not deduplicated:** a banned plate met three times tells the keepers three times.
- **Violations are paid at the office only**; billing them to a unit's invoice (ADR 0046) and paying online are not built.
- **An override is not an entry:** an emergency vehicle let through a locked gate leaves no entry row, only the override.
