# 0090 — The field team, part b: a technician's last known location with consent, staff certificates with expiry, dangling accounts and access reviews, and peak reinforcement

**Status:** Accepted · M2-12 (part b) · amends ADR 0078 (its part b), 0033 (the technician's steps carry a location), 0034 (the arrival carries one; "no location tracking" stays), 0050 (a single slot a reinforcement writes), 0087 (the calendar reads the staff's certificates), 0079 (service pressure suggests reinforcement), 0073 (three inbox types), 0023 and 0036 (erasure and the export), 0029 (a file purpose), 0010 (no new permission; `accounts.manage` reviews access)

## Context

ADR 0078 built part a of M2-12 and listed part b: "the last known location at en-route, arrive and start, with consent; staff certificates with expiry; access reviews and dangling-account alerts; peak reinforcement". The owner settled the scope, the location's and the certificates' rules (2026-11-08), and approved the recommendations for the account checks and reinforcement the same day, as recorded under each section.

## Decisions

### A technician's last known location (`src/maintenance/field-location`)

The owner's decisions: only with the technician's consent, recorded, revocable and audited; only at three moments of a ticket — setting off, arriving, starting the work — never continuous; kept 30 days, then purged; removed with the person's erasure; never in a resident's view; kept out of lists.

- **Consent** (`technician_location_consents`): the technician's own, `tickets.work`: `GET`, `POST`, `DELETE /technician/location-consent`. One live at a time, under the technician's consent lock (a partial unique index behind it); giving it again answers the same and audits nothing. Revoked once, by themselves (`self`) or by the system when they are deactivated or erased. Audited `technician_location.consent_granted` and `.consent_revoked` (`by`, `removed`: how many points went). The rows hold times only and are never deleted: they are the record of consent.
- **A point** (`technician_locations`) comes only with the step's own request: `POST /technician/tickets/{id}/en-route` (`en_route`), `…/start` (`started`) and `…/visits/{visitId}/arrive` (`arrived`) take an optional `location {latitude, longitude, accuracyMeters?}`. An arrival that starts the work keeps one point, `arrived`. The live consent is read FOR SHARE in the step's transaction, after the ticket's lock; without one the step is refused (409 `LOCATION_CONSENT_REQUIRED`) and nothing moves. A point names the consent it was taken under; it is timed by the database's clock and never changed.
- **Revoking removes every point** the technician has, in the same transaction: a revocation either waits for a step holding the consent (and removes its point) or ran first (and the step is refused).
- **Kept 30 days:** the sweep `maintenance.location_purge` (hourly) deletes older points.
- **Read** one technician at a time: `GET /staff/field-team/technicians/{id}/location` (`field_team.manage` or `tickets.dispatch`, no-store): their latest point of the 30 days, its moment, the ticket by number, and whether they consent now. Every read is audited (`technician_location.read`: found, moment — never where). The technician reads their own consent and points of the 30 days (100 at most).
- **Never** in a list (the technicians' list, the dispatch list), a resident's view (the ticket, its visits), a notification or the audit log. The PII scan holds a sentinel latitude to the two reads above.
- **Personal data:** the export gains `field-team/location.json` (consents, points kept). An erased technician's consent is revoked by the system, which removes the points.

### Staff certificates (`src/maintenance/certificates`)

The owner's decisions: each has an expiry and an optional paper through object storage; warn only — the field team and the managers are told 30 days before and on the day; in the compliance calendar; an expired one blocks neither assignment nor work.

- **Kept by the field team** (`field_team.manage`): `GET|POST /staff/field-team/certificates`, `GET|PATCH|DELETE …/{id}`. A certificate is an active staff account's (`CERTIFICATE_HOLDER_NOT_ELIGIBLE`): a kind (`electrical`, `plumbing`, `gas`, `hvac`, `working_at_height`, `first_aid`, `fire_safety`, `driving`, `security_licence`, `other`), a title, the issuer and its reference, the day issued and the day it expires — its last day in force, as a vendor's paper (ADR 0077).
- **The paper**: file purpose `staff_certificate` (a photo or a PDF of 10 MB, uploaded by `field_team.manage`), claimed and attached through the files service (ADR 0029). Replaced or removed by a PATCH (the old one marked deleted, `replaced`); a removed certificate's goes (`withdrawn`). A list carries no link; a single read does, no-store.
- **A renewal** is a PATCH with a new expiry: its notices start again. Removed once (`DELETE`): the record stays, changes no more (a trigger).
- **The holder** reads theirs at `GET /staff/my-certificates` (any staff account, no permission; anyone else 403).
- **Warn only.** The sweep `maintenance.staff_certificates` (hourly) tells the holder and the `field_team.manage` holders — the manager among them — once per expiry 30 days ahead (`staff_certificate.expiring`: the kind, the day, the days left) and on the day (`.expires_today`). Never a removed certificate or an inactive holder; a day missed is not told late; under the row's lock, judged again there. Nothing reads a certificate to refuse an assignment or a start.
- **The compliance calendar** (ADR 0087) reads the live certificates of active holders where they are, as it reads the vendors' papers: `source: staff_certificate`, its kind and title, `holderId` and `holderName`, due soon within the 30 days, expired from the day after.
- **Personal data:** the export gains `field-team/certificates.json` (no paper, no filer). An erased holder's certificates are deleted with their papers (`staff_certificate.erased`, the count).
- Audited `staff_certificate.added` (holder, kind, expiry, a paper or not), `.changed` (words as `{changed: true}`, the days from and to, the paper `added|replaced|removed`), `.removed` (kind). Never its reference.

### Dangling accounts (`src/core/account-checks`)

The owner's decisions (2026-11-08, as recommended): the compound's side only — staff, manager and contractor accounts; residents and family follow their occupancy (ADR 0023, 0036). An active account is dangling when:
- (a) it has not signed in, nor used a session, for the compound's idle days (60 by default, 14 to 365);
- (b) it is a contractor whose vendor is suspended (ADR 0077, 0088);
- (c) it is a staff account nobody signed into within 14 days of its creation.

- **Found by a sweep** (`accounts.dangling`), told once to the `accounts.manage` holders (`dangling_account.found`: the reason only), an item of the staff inbox (`dangling_account`, due in 7 days). One open finding per account (a partial unique index behind the account's lock). The reason is the first that holds: a vendor's suspension, then never signed into, then idle. Last activity is the latest session's start or use (sessions are kept after they end).
- **Rule (b) is maintenance's**: core imports no domain, so maintenance registers it (`DanglingAccountsService.registerRule('vendor_suspended', …)`); a missing rule stops the start.
- **Decided once**, by an `accounts.manage` holder, never on their own account (409 `CANNOT_CHANGE_OWN_STATUS`): `POST /staff/access/dangling-accounts/{id}/keep {reasonCode}` (`danglingKeep`: on leave, seasonal work, rarely needed, other) mutes the account for 90 days; `…/deactivate` deactivates it in the same transaction, as `PATCH /accounts/{id}/status` does (its sessions end, the domains react, the after-commit work runs). `409 DANGLING_ACCOUNT_DECIDED` after.
- **Cleared by the system** when it no longer holds (signed in again, the vendor reinstated: `active_again`) or the account left (`left`, through the deactivation and erasure hooks).
- Audited `dangling_account.found`, `.kept`, `.deactivated`, `.cleared`, each about the account, with the finding's id.

### Access reviews (`src/core/account-checks`)

The owner's decisions (2026-11-08, as recommended): every 90 days (a setting of 30 to 365), a frozen snapshot of every active staff, manager and contractor account with its role, the role's permissions and its last activity; `accounts.manage` decides each line, keep or revoke — revoke deactivates in the same transaction; nobody decides their own line, and the system manager's line is kept only; due in 14 days as the inbox item `access_review`, overdue told once; closed once every line is decided. No new permission: `accounts.manage` is the reviewer.

- **Opened** by the sweep `accounts.access_review` once the cadence passed since the last review opened (the first that long after the compound was made), or by hand: `POST /staff/access/reviews` (409 `ACCESS_REVIEW_OPEN` while one is open). One open per compound, under the compound's review lock and a partial unique index. Numbered `AR-000001`. Told to the `accounts.manage` holders (`access_review.opened`: the lines).
- **The lines** (`access_review_lines`): the account, its kind, its role (id, key, name), the role's permissions then, its last sign-in, and whether it is the system manager's (`protected`: the `manager` system role). An account made after waits for the next review.
- **Decided once**: `POST /staff/access/reviews/{id}/lines/{lineId}/decide {keep|revoke}`. Never one's own (403 `ACCESS_REVIEW_OWN_LINE`); the protected line is kept only (409 `ACCESS_REVIEW_LINE_PROTECTED`); 409 `ACCESS_REVIEW_LINE_DECIDED` after; 409 `ACCESS_REVIEW_CLOSED` once closed. Revoke deactivates the account in the same transaction (a domain's refusal — a manager's handover while a board sits, ADR 0075 — refuses the decision). A line whose account left first is marked `left` by the system.
- **Closed** with its last line (`kept + revoked + left = lines`, a CHECK), audited with the counts.
- **Overdue** is the inbox's own notice (`staff_inbox.overdue`, once, ADR 0073): the review is due 14 days after it opened, the compound's inbox setting for the type when it sets one.
- **Settings**: `GET|PATCH /staff/access/settings` (`accounts.manage`): the idle days and the cadence, one row made by the first change under the compound's lock, audited `access_review.settings_changed`.
- **Locks:** the line's or the finding's account first (FOR UPDATE to deactivate, FOR SHARE to keep) — the order a deactivation takes it before its hooks reach the review or the finding — then the review, then the line.

### Peak reinforcement (`src/maintenance/reinforcement`)

The owner's decisions (2026-11-08, as recommended): the system suggests, the field team decides; nothing goes to an off-duty technician by itself. The service-pressure rise gives `field_team.manage` an inbox item; the field team can also call by hand. A call is a critical notification to the technicians off duty, 1 to 10 needed, a window up to 12 hours; accepting writes a single roster slot under the technician's lock, an overlap refused; the call closes when filled, at its start, or when called off.

- **A suggestion** (`reinforcement_suggestions`) is made when service pressure's rise is told (ADR 0079), in that transaction under the pressure row's lock, with its figures (open tickets, available technicians, the threshold); one open per compound. The field team is told (`reinforcement.suggested`) and has the inbox item `reinforcement_suggestion` (due in an hour). Answered by a call naming it, dismissed with a code (`reinforcementDismiss`), or lapsed when the pressure eases or is turned off. It follows the pressure notice's debounce: one an hour at most.
- **A call** (`reinforcement_calls`, `field_team.manage`): `POST /staff/field-team/reinforcement-calls {needed, startsAt, endsAt, zoneId?, suggestionId?}`. 1 to 10 needed; a window starting 15 minutes to 12 hours ahead, lasting 1 to 12 hours; a zone in service or the whole compound. It reaches every technician off duty at the send — an active `tickets.work` holder not available (ADR 0033), never the sender — recorded as reached (`reinforcement_call_recipients`) and told critically (`reinforcement.called`).
- **Answers**, once each, while open and before the start: `POST /maintenance/reinforcement-calls/{id}/accept|decline` (`tickets.work`; a technician it did not reach gets 404). Accepting writes a single roster slot of the call's window and zone (ADR 0078), made by the call's sender, through a new `StaffDuty` writer the gate registers: under the technician's roster lock, refused on an overlap (409 `ROSTER_OVERLAP`, nothing recorded) or when they may not work. Going on duty then fills the slot, with its lateness and overtime. The last one needed fills the call (`reinforcement.filled` to the sender and the field team).
- **Called off** once with a code (`reinforcementCancel`): the accepted slots nobody filled yet are cancelled (`schedule_change`, by the caller); whoever it reached and did not decline is told (`reinforcement.cancelled`). **Closed at its start** by the sweep `maintenance.reinforcement` (every minute, SKIP LOCKED, judged again under the row by the database's clock).
- **Reads:** the field team's `GET /staff/field-team/reinforcement-calls[/{id}]` (the single read with whom it reached and their answers) and `…/reinforcement-suggestions`; a technician's `GET /maintenance/reinforcement-calls` (the calls that reached them, their own answer).
- **Locks:** the technician's account FOR SHARE, then the call FOR UPDATE, then the roster lock; a call-off and the sweep take the call, then each slot.
- Audited `reinforcement_suggestion.suggested|dismissed|lapsed` and `reinforcement_call.sent|accepted|declined|filled|cancelled|closed`, with counts, ids and codes.

### Catalogs and tables

- **Errors:** `LOCATION_CONSENT_REQUIRED`, `STAFF_CERTIFICATE_NOT_FOUND`, `DANGLING_ACCOUNT_NOT_FOUND|DECIDED`, `ACCESS_REVIEW_NOT_FOUND|OPEN|CLOSED|LINE_NOT_FOUND|LINE_DECIDED|OWN_LINE|LINE_PROTECTED`, `REINFORCEMENT_CALL_NOT_FOUND|CALL_CLOSED|ANSWERED|SUGGESTION_NOT_FOUND|SUGGESTION_DECIDED`; field `CERTIFICATE_HOLDER_NOT_ELIGIBLE`.
- **Notices:** `staff_certificate.expiring|expires_today` (maintenance), `dangling_account.found` and `access_review.opened` (management, a decision), `reinforcement.suggested` (a decision), `.called` (critical, a decision), `.filled`, `.cancelled`. Params are codes, days and counts: never a name, a coordinate or a number.
- **Migrations** `20270614090000` (the file purpose, alone) to `20270614090500` (the staff inbox's two CHECKs and the files' content type CHECK recreated with every value before them), dated after M3-4's `20270613090000`. Nine tenant tables under RLS, forced, with composite keys; every CHECK reviewed (a code is tested NOT NULL before its list); every unique index mapped neutral.

## Deviations and assumptions for the owner

1. **A location sent without consent is refused, not dropped** (409, nothing moves), as the repo refuses a field it would not keep. The app reads the consent first.
2. **Revoking the consent removes the points already taken**, not only future ones: "no consent, no location". Leaving (deactivation, erasure) is a revocation by the system.
3. **One point per request**: an arrival that starts the work keeps `arrived`, not a second `started`.
4. **Reading a technician's location is audited**, beyond the consent's own entries; the dispatch (`tickets.dispatch`) reads it too, besides the field team.
5. **A certificate's holder is a staff account** (technicians, guards, supervisors); not a manager or a contractor. "The field team and the managers are told": the holder and every `field_team.manage` holder (the manager by default).
6. **Expiry is the last day in force**, as a vendor's paper: "on the day" is that day; the day after it is expired. A day missed by the sweep is not told late. An already-expired certificate recorded is not told.
7. **An erased holder's certificates are deleted**, not kept as tombstones: they describe the person.
8. **The dangling sweep and the review sweep look hourly** (the repo's sweep cadence) rather than once a day; each finding and each review is told once, so the effect is the recommended daily look.
9. **The first access review opens 90 days after the compound was made** (an existing compound older than that gets one at the first sweep after the deploy), or when someone opens one by hand.
10. **An access review's overdue notice is the inbox's** (due in 14 days by default), not a notice of its own; the compound may change the type's due hours as any inbox type's.
11. **The system manager's line** is any account on the `manager` system role; its revocation is a manager's handover (ADR 0075), not a review's.
12. **A reinforcement suggestion follows the pressure notice**: one an hour at most, as ADR 0079 debounces the rise.
13. **A call's earliest start is 15 minutes ahead** ("from now" in the dashboard), so a technician can answer before it closes at its start.
14. **A call reaches the technicians off duty at the send** only; one who goes off duty after is not added. A call-off cancels accepted slots with `schedule_change` by the caller, not a new system reason (the slots' reason CHECK stays as ADR 0050 made it).

## Consequences

- The manager dashboard's Field team gains Reinforcement, Certificates and Location tabs; a new page, Access checks (`accounts.manage`), holds the dangling accounts, the open review with its lines, and the settings. The inbox's three types open those pages.
- The technician app sends `location` with the three steps once its holder consented, and lists and answers reinforcement calls.
- ADR 0034's "No location tracking" stays: a point is a step's, with consent, never a track.

## Open

- The location's consent text and its version shown in the app are not recorded.
- Certificates required per ticket category, and assignment rules on them, are not built (warn only, by the owner's decision).
- Reinforcement beyond the technicians (guards at peaks), and a suggestion per category or building.
- A review's lines for accounts made while it is open; a review of the residents' side.
