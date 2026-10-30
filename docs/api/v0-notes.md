# API v0 notes

API v0 is a draft (ADR 0025): it exposes every feature so it can be exercised end to end, before the design exists. This file lists what is known to change.

## To reshape with design

- `GET /units` is ordered by `createdAt`; managers will likely want `code` order and search.
- `GET /me` omits the holder's own birth date; add it if the profile screen shows it.
- `GET /units/:unitId/household` is an object (`members`, `invites` for the primary or a household delegate), not a list; a manager who holds `residents.read` also gets each member's `grantedPermissions` (codes only), so the revoke dialog offers what the member holds; the screens decide whether invites get their own endpoint.
- `GET /units/:unitId/deferred-actions` leaves out `payload`: no domain submits deferred actions yet; the decision screen will say what it shows.
- `GET /worker-engagements/:id` was added so a manager can attest a passport worker's birth date; the review screen may want the worker's other engagements.
- Lists name people by id only where a name would need a join the screen may not want: compliance cases (`workerId`), card incidents (`workerId`), erasures (`accountId`), audit entries (`actorId`, `targetId`).
- `GET /registrations` computes conflicts per request, row by row; fine for a review queue, to revisit if the screen shows many at once.
- A card incident's `note` is readable nowhere in v0; the incident screen decides who sees it.
- Capabilities without endpoints yet (finance, governance, documents) are flags only.
- Worker in/out notifications go to every residing member, twice a day; per-account notification preferences come with the design.
- Gate entries may be backdated up to 24 h (offline readiness); the manager's entries screen should highlight a large gap between `occurredAt` and `recordedAt`.
- `GET /me/gate-requests` is bounded (the pending requests of the caller's units); `GET /gate/inside` is paged by entry time. Both may want a push channel rather than polling once the apps exist.
- `POST /gate/verify` returns one `display` object for visitors and workers (fields of the other kind are null); the guard screen may want two shapes.
- The visitor's page is two POSTs (`/public/visitor-passes/lookup`, `/not-me`) so the token never sits in a URL; the web app reads it from the link's fragment (ADR 0030).
- A pass's `link`, `qrPayload` and `code` come at creation or from `POST /visitor-passes/:id/reissue-link`, and again from `GET /visitor-passes/:id` while the pass is active, for its host and the unit's primary (ADR 0043: the token is derived from `VISITOR_PASS_TOKEN_KEY`). A pass issued before that shows `code: null` until its link is reissued. There is no GET for a worker's card data (a lost card is a reissue).
- The worker card's `preferredLanguage` is always `ar` until worker registration takes a language.
- `POST /gate/verify` takes `code` or `qr`; the guard app may prefer a dedicated QR route once scanning has its own error states.
- A resident's entry QR (ADR 0031): `POST /me/entry-credentials` returns the secret once; the phone computes `JWR2.<id>.<step>.<mac>` offline every 30 seconds (the formula and test vectors are in the ADR). `GET /me/entry-credentials` shows only id, device name and creation time. The guard's `display` is one flat object for visitors, workers and residents; the guard screen may want three shapes.
- `GET /me` carries `photoUrl` (short-lived, no-store); the app re-reads it rather than caching it.
- Maintenance (ADR 0032) has one route family per audience (`/tickets`, `/technician/tickets`, `/maintenance/tickets`) with its own views; the screens may want them merged once they exist.
- Ticket actions answer 204; the apps re-read the ticket. A ticket's number (`MT-000123`) is in every view but is not searchable yet.
- Dispatchers (maintenance_supervisor) never see the reporter's phone; in an emergency they may need to call. Decide with the design whether emergency tickets show the reporter's phone to dispatchers.
- Every dispatcher is told of every message on every ticket (`ticket.message`); per-account preferences come with the design.
- A rejection's or reopen's note shows up as the reporter's message in the thread, not as a field of the ticket.
- Community life (ADR 0040) has one route family per side: residents read `/announcements`, `/events`, `/polls`, `/suggestions`, `/suggestion-board` and `/me/daily-brief`; the staff write under `/community/...`. Every answer is `no-store`; every create answers a small "created" view and every other action 204, so the apps re-read.
- Neighbours (ADR 0042) has one route family per side too: residents use `/neighbour-complaints`, `/neighbour-posts`, `/neighbour-claims`, `/neighbour-conversations`, `/neighbour-blocks` and `/neighbour-welcome`; the unit a complaint is about uses `/neighbour-notices`, by the notice's own id and never the complaint's; the staff work under `/neighbours/...`. A conversation's views carry no id or name of the other side: `mine`, a building, and a first name once both agreed.
- Facilities and bookings (ADR 0044): residents use `/facilities`, `/facilities/{id}/slots`, `/units/{unitId}/bookings`, `/bookings/{id}`, `/units/{unitId}/booking-standing`, `/club/plans` and `/units/{unitId}/club-membership`; the staff work under `/staff/...`. A slot is `free`, `full` or `closed`, never how full or by whom; a resident's booking view has `mine` and no account id. `GET /facilities/{id}/slots` takes a local `date` (default today) and leaves out what is too soon or too far. Actions answer 204, except the club's payments and reversals, which answer the record. Money is a string in EGP with two decimals; club days are local `YYYY-MM-DD`, a period's end excluded, and a membership's `activeThrough` is its last day.
- A booking cancelled by a closure, an erasure or someone leaving says so in `cancelReason` (`bookingSystemCancel`); the apps show the reason, the push texts never do.
- The staff's memberships list (`GET /staff/club-memberships`) is bounded, one per unit, not paged; the screen may want paging and a unit search once compounds are large.
- Texts the staff write come in `…En` and `…Ar`; a language is whole or null and at least one is there. Nothing is translated: show the reader's language when it is there, the other one otherwise.
- An audience is evaluated at each read. A list and a single read answer for the caller as they are now; an id that is not theirs to read is 404 with the resource's own code, the same as an unknown id.
- `GET /announcements` is by publication, newest first; `?pinned=true` gives what is pinned now, for the top of the screen. Opening one is told with `POST /announcements/{id}/read`; `read` on an item is the caller's own.
- A poll's `units[]` are the caller's units it is put to. `mayVote` says whether the caller casts that unit's vote; `choice` is the unit's current choice, only while the poll is open and only to those who cast its vote; it is null after the poll ends and cannot be shown again. `resultsHidden` says why counts are null (`not_voted`, `few_votes`, `not_open`, `cancelled`).
- `POST /polls/{id}/votes` replaces the unit's choice. Its `Idempotency-Key` is remembered without the body: a retry replays, and the same key with another choice replays too (never 409).
- `PUT /events/{id}/rsvp` needs `unitId` only when the event is put to several of the caller's units; 409 `COMMUNITY_EVENT_FULL` carries `params.remaining`.
- The suggestion board shows the staff's summary; a suggestion's own text exists only on `GET /suggestions/{id}` for its author.
- `GET /me/daily-brief` is computed per call and cheap to refetch on focus; `tickets` and `requests` are null when the caller's role does not use the feature.
- Requests to the management (ADR 0039) have one route family per side (`/management-requests`, `/management/requests`); every answer is `no-store` and every action answers 204 or a small "created" view, so the apps re-read the request.
- A request has no subject: the staff inbox shows a 120-character `preview` of its first message. The request screens decide whether a subject is wanted.
- `GET /me/requests` is ordered by last activity, which moves: an item that changes between two pages may be seen twice or not at all. Its `status` is the item's own (a ticket's or a request's), a plain string.
- Appointment slots are read (`/management-appointment-slots`) and then booked; a slot may fill in between (409 `MANAGEMENT_APPOINTMENT_SLOT_FULL`), and the screen re-reads. A confirmed appointment whose time has passed stays `confirmed`: "attended" and "no show" come with the design.
- Every handler is told of every new request and of every message on an unassigned one; per-account preferences are the `management` category only.
- Photos are never removed from a ticket in v0, and a ticket's list has no photo; the detail carries presigned URLs (no-store).
- Dispatch (ADR 0033): automatic dispatch is off in every compound until the manager turns it on in `PATCH /maintenance/dispatch-settings`. The settings screen should show **how many available technicians have specialties** before the manager enables it (`GET /maintenance/technicians` has what it needs): with none, every new ticket is `no_candidate` and every dispatcher is told.
- Turning dispatch on assigns up to 50 queued tickets right away, after the answer (the screen re-reads the queue shortly after); the rest waits for the next sweep (hourly by default) or a dispatcher's `POST /maintenance/tickets/:id/auto-assign`, which answers 503 `DISPATCH_BUSY` if the compound's dispatch lock stays held (try again). The screen may want a "dispatch the queue" button that calls it per ticket.
- A dispatcher sets a technician's availability with `POST /maintenance/technicians/:id/availability`: `unavailable` needs a `reasonCode` (sick, leave, training, other); `available` takes none, and sending one is a 400 (`FIELD_NOT_ALLOWED`).
- To open a ticket for someone in a unit, the dispatch screen lists who may be its reporter with `GET /maintenance/units/:unitId/reporters` (`tickets.dispatch` and `residents.read` together): occupants and the family members who hold `tickets`, ids and names. For a common area there is no such list; any resident with `tickets` on some unit is accepted.
- A technician's availability history is readable nowhere in v0; `GET /maintenance/technicians` shows the current state and when it changed. `workload` is in points with two decimals (status weight × priority multiplier over assigned, in-progress and on-hold tickets).
- `GET /maintenance/tickets/:id/dispatch-attempts` answers "why wasn't this assigned?"; the screen decides how much of it to show.
- Specialties are read by dispatch (`tickets.dispatch`) or by whoever may write them (`maintenance.manage`), and written by the manager (`maintenance.manage`); a supervisor who is not also a manager cannot change which specialties a category needs.
- Visits (ADR 0034) have one route family per audience like tickets, plus `GET /me/units/:unitId/visits` for every adult who lives in the unit. Visit actions answer 204 (a proposal, counter or reschedule 201 with the new visit's id and window); the apps re-read the list. The resident app should present absence-entry consent as its own step after confirming, never as part of it, and show who granted it.
- A visit's window is checked against the database's clock: an app whose clock is off may see `VISIT_TOO_SOON` for a time that looks 15 minutes away.
- A worker receiver is `{ engagementId }`; the app lists the unit's active workers from `GET /units/:unitId/workers`. A worker whose engagement ends stops showing as receiver at once.
- The SLA (ADR 0034) is off in every compound until the manager turns it on in `PATCH /maintenance/sla-settings`; turning it on starts the open tickets' clocks over the next seconds (the screen re-reads), never backdated. Targets are per category and priority (`PUT /maintenance/categories/:id/sla-targets`, all three priorities at once). Residents see `sla` (due times, paused) on a ticket; dispatch also sees the states and `GET /maintenance/tickets/:id/sla-events`. The dispatch list filters by `overdue=true` and `escalated=true` (none while the SLA is off) and by `open=true`: every status but `closed` and `cancelled`, whatever the SLA. `escalated=true` alone also returns finished tickets escalated in their current cycle; a screen of what still needs attention sends `open=true` with it.
- The residents confirm a technician's arrival with `POST /tickets/:id/visits/:visitId/confirm-arrival` (ADR 0038), once, on an `arrived` visit. The app shows the button while `status` is `arrived` and `arrivalConfirmedAt` is null; nothing waits for it.
- `en_route` (ADR 0038) is a ticket status between `assigned` and `in_progress`, sent by the technician app with `POST /technician/tickets/:id/en-route`. It is optional: `start` still works from `assigned`. Apps that switch over `status` must show `en_route` ("technician on the way"); it allows every action `assigned` allows.
- `GET /tickets/:id/visit-slots` (ADR 0038) lists free windows in the compound's visiting hours (`/maintenance/settings`, 08:00–18:00 hourly by default) for the "Change visit time" screen; the app sends the chosen slot to `counter` or `reschedule`. It is not a reservation, and days off or technician hours are not modelled yet.
- `POST /tickets/:id/confirm` takes an optional `technicianRating` (ADR 0038) beside `rating` (the service's). Dispatch reads both in `feedback`; the technician never does.
- `unitLocation` (ADR 0038) is the room of a unit's ticket (`kitchen`, `bathroom`, `living_room`, `bedroom`, `balcony`, `other`): optional on `POST /tickets`, refused with `commonArea`, and on every ticket view (null when not given).
- Confirming a visit proposal whose start has already passed is 409 `VISIT_WINDOW_PASSED` (ADR 0038; it used to be accepted). The app offers a counter-proposal or a cancellation instead; a stale proposal stays active until one side answers it.
- **Overdue and escalation** (ADR 0038): a resident's ticket, on the list and the detail, carries `sla` (with `overdue`), `escalatedAt` and `canEscalate`. Show "Overdue" from `sla.overdue` and "Request escalation" from `canEscalate`; do not rebuild the rules from the due times. `POST /tickets/:id/escalate` takes no body; send an `Idempotency-Key`. Without one, a 409 `TICKET_ALREADY_ESCALATED` after a retry means the first attempt went through.
- **Preventive services** (ADR 0038): `GET /preventive-services` is the "What" list of "Request preventive maintenance", in the compound's order, with `nameAr` and `nameEn` written by the compound. The manager's screen is `/maintenance/preventive-services` (a service's `key` never changes; `active: false` retires it).
- **Preventive requests** (ADR 0038): pick a slot from `GET /preventive-slots?unitId=…` and send it to `POST /tickets/preventive` with the `serviceId`. The window must be inside the compound's visiting hours (`VISIT_OUTSIDE_HOURS` otherwise), so send a slot as it came. The result is a ticket with `kind: 'preventive'`, `preventiveService` and `requestedStartsAt`/`requestedEndsAt`; when a technician takes it, a visit at that window appears, proposed for the residents, and the technician confirms or counters it. **`description` is `''` for a preventive ticket without a note**: show the service's name instead. A preventive ticket has no `sla` and is never overdue.

- **Preferences** (ADR 0036): `GET/PATCH /me/notification-preferences` returns every category with both channels, quiet hours and the pause. `push` off means the category is not pushed to the phone; during quiet hours or a pause nothing is pushed at all (not held for later, unlike email), and critical notifications always are (ADR 0041). A PATCH changes only what it names; pause choices are `1h`, `8h` and `until_resumed`, and `null` ends one. The settings screen should say which notifications always arrive (critical).
- **Consents:** `POST /me/consents/grant` takes the version of the text the app showed; a stale app gets `CONSENT_VERSION_MISMATCH` with `params.current` and should show the new text. The technician's `reporterPhone` may turn null between two reads (revoked, or the work done).
- **Step-up:** `POST /me/step-up`, then `/verify` with the emailed code, then the sensitive action on the same session within 10 minutes. One code opens one action.
- **Exports:** `POST /me/data-exports` answers `pending`. The archive is ready when the inbox says so (`data_export.ready`, no link), and `GET /me/data-exports/{id}/download` gives a short-lived URL to open at once. An assisted export's email link opens a web page that calls `POST /public/data-exports/code`, then `/download` with the emailed code, at most three times.
- **Deletion:** `POST /me/deletion-request` may answer 409 `DELETION_BLOCKED` with `params.blockers`; the app should explain each and what clears it. A request can turn `queued` after its cooling-off; the managers' screen is `GET /erasures` with `POST /erasures/{id}/erase` or `/close`.
- **Unusual login:** apps must send `X-Jiwar-Install-Id` (a UUID made once per install) on `POST /auth/select-account`, or every login looks like a browser. The alert's in-app action is `POST /me/devices/{targetId}/not-me`, and the email's is the web page below; both freeze the account and end every session, the caller's included.
- **The email link pages (ADR 0036): a contract the web app implements (`apps/public`).** The token is only in the fragment, and the page posts it in a body:
  - **Routes:** `<PUBLIC_APP_URL>/a/not-me#<token>` and `<PUBLIC_APP_URL>/a/export#<token>`. The path says what the link is for; the fragment (`<uuid>.<64 hex>`) is the secret.
  - **The fragment:** read it with `location.hash` and never send it in a URL — not as a path segment, not in a query string, not in analytics, error reports or logs. Remove it from the address bar (`history.replaceState`) once read, so it is not left in the history or shown on screen. Never put it in `localStorage`.
  - **`not-me`:** show what will happen (the account is frozen, every session ends, the management reactivates it) and ask the person to confirm; only then `POST /api/v1/public/not-me {token}`. `204`: done; say so and that they should contact the management. The link works once.
  - **`export`:** first `POST /api/v1/public/data-exports/code {token}` (`202`): a 6-digit code goes to the same email. Then ask for it and `POST /api/v1/public/data-exports/download {token, code}`. `200 {url, expiresAt}`: open `url` at once (it lasts minutes) and never store or share it. Each download needs a new code; the third success is the last.
  - **Errors to handle, by `code`:**
    - `ACTION_TOKEN_INVALID` (404), the same for an unknown, used, expired, spent or wrong-page link, and for an export that is no longer available: the link no longer works;
    - `STEP_UP_CODE_INVALID` (403, download only): a wrong, used or expired code; offer to send a new one;
    - `RATE_LIMITED` (429): wait and try again later;
    - `VALIDATION_FAILED` (400): a malformed token or code;
    - `STORAGE_UNAVAILABLE` (503, download only): try again later.

    Never tell the person whether the link existed.
  - **Not indexed, not cached:** serve the pages with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` (and `<meta name="robots" content="noindex">`); load no third-party script on them. The API answers both export calls with the same headers (`PublicPageHeaders`).
- **The invite and registration pages (`apps/public`).** The API builds no link for these: whoever holds the token builds it. A household invite's is `<PUBLIC_APP_URL>/i#<token>` (the `token` of `POST /units/{unitId}/household/invites`' answer) and a registration link's is `<PUBLIC_APP_URL>/r#<token>`. The fragment rules above apply. `/i` calls `POST /invites/accept/start {token}` then `/complete {token, code}`; `/r` calls `POST /registrations/start`, then `/complete` with the same body and the code. Both `start` routes answer the same for an unknown link, so the page never says whether the link existed. Registration has no document upload; the registrant attaches proofs afterwards on `/rs` (ADR 0062).
- **Assisted:** the management screens use `/accounts/{id}/…` with a `reasonCode` on every write; the account is always told.
- `GET /gates/status` is the resident's and family's view of the gates: `id`, `name`, `open` (the gate is in service) and `phone` (ADR 0043, E.164 or null) per gate, `Cache-Control: no-store`, no permission needed; any other account kind gets 403. Residents never read `GET /gates` or `GET /gate/entries`: `gate.read` is the management's, and a resident role cannot hold it.
- `GET /me/units` carries the unit's `unitType`, `areaSqm` (square metres, two decimals) and `status` (`active` or `closed`) for the unit card (ADR 0037). Residents never read `GET /units/:id`.
- Worker wages (ADR 0037) are recorded, never processed: `PUT /worker-engagements/:id/wage` sets the monthly wage, `POST /worker-engagements/:id/wage-payments` records one month (`YYYY-MM`) once, `GET` lists them. Amounts are decimal strings in the compound's currency; the app shows "Payment sent" after the 201 and the receipts go by email and worker notice. `monthlyWage` on a unit's worker is **absent** (not null) unless the caller is on the employer side (the primary, a `workers` delegate, the engagement's requester): show the wage block and "Pay Wage" only when the field is there. The management's `GET /worker-engagements` and `GET /worker-engagements/:id` always carry `monthlyWage` (null until set). A payment never closes anything: after an engagement ended, the wage still has to be settled with the management.
- The management closes a wage obligation with `POST /worker-engagements/:id/wage-obligation/settle`, a `kind` (`settle_before_close` by default, or the underage `pay_in_full`) and a `reasonCode` from the kind's list (`household_payment_confirmed`, `worker_confirmed`, and `nothing_owed` or, for `pay_in_full`, `referred_to_authorities`); `GET /worker-engagements/:id` lists `openWageObligations`. Until then the employer's deletion request answers `open_worker_obligations` (ADR 0037).
- `GET /units/:unitId/workers/:id` (ADR 0037) is the resident's worker page: the list item and, for the employer side, `monthlyWage` and `lastPaidPeriod` (both absent for anyone else). The page's "last check-in" comes from `GET /worker-engagements/:id/attendance`.

### Gate card — visitors (ADR 0043)

The full notes for the mobile team, with examples, are in [`notes/gate-card-visitors.md`](notes/gate-card-visitors.md).

- Recurring windows were always times of day (`{ from: "HH:mm", to: "HH:mm" }`, compound time zone, overnight when `to` < `from`). The contract wrongly showed a maintenance visit's `{ startsAt, endsAt }`: two classes shared a name. Regenerate the client.
- `GET /visitor-passes/{id}` (no-store) is for any member of the unit; the secrets go to the host and the primary, the visitor's data to the host.
- Passes carry `enteredAt`, `exitedAt`, `entriesUsed` (one-time) and `vehiclePlate` (host only). `status` is the described enum `VisitorPassStatus`.
- **A group pass lets in one person per entry.** A one-time pass is `used` when `entriesUsed` reaches `partySize`. A recurring pass caps how many are inside at once. Guard apps record one entry per person and read `display.entriesUsed`/`insideCount` from verify, and `insideCount` from `/gate/inside`.
- Standing instructions: `GET`/`POST /units/{unitId}/standing-instructions` and `DELETE …/{id}`. The guard sees them on a waiting request and decides by one with `POST /gate/approval-requests/{id}/apply-instruction`. The manager's `allowAlwaysAllow` setting turns `always_allow` into `call_first`.
- Gate requests take `photoFileId` (purpose `gate_request_photo`, the guard's). They carry `photoUrl` (presigned, minutes; deleted 7 days after the decision) and, for the household, `gatePhone`. The guard's request views and `/me/gate-requests` are now `no-store`.
- Gates have an optional `phone` (E.164), set by the manager.
- Not built: a `count` on entries for a group arriving together, a notification when a visitor comes in on an `always_allow`, a history of decided requests for residents.

### Gate card — vehicles & parking (ADR 0045)

The full notes for the mobile team, with examples, are in [`notes/gate-card-vehicles.md`](notes/gate-card-vehicles.md).

- Vehicles (`GET`/`POST /units/{unitId}/vehicles`, `GET`/`PATCH`/`DELETE /vehicles/{id}`) for whoever holds the new `vehicles` capability. A new plate sends a vehicle back to `pending`; colour, model, type and the photo do not. `permitStatus` reads `expires_soon` and `expired` when asked.
- `GET /units/{unitId}/parking`: the unit's slots and the visitor areas' free spaces now.
- Visitor parking (`GET`/`POST /units/{unitId}/visitor-parking-bookings`, `DELETE …/{id}`) for whoever may invite: for a pass or a visitor's name; the area's capacity holds at every instant.
- Fines (`GET /units/{unitId}/vehicle-fines`, `GET /vehicle-fines/{id}`, `POST /vehicle-fines/{id}/appeal`): appealed once within 30 days; paid at the management office (no gateway before R6).
- Parking reports (`POST`/`GET /parking-reports`): about a plate, never a unit; the reported unit never learns who reported.
- The guard: `POST /gate/plate-lookup`, `GET /gate/visitor-parking`, and `display.parking` on verify.
- Uploads are `photoFileId` / `licencePhotoFileId` (purposes `vehicle_licence`, `parking_photo`), not `photoUploadId`.

### Gate card — emergencies and gate services (ADR 0047)

The full notes for the mobile team, with examples, are in [`notes/gate-card-emergency-services.md`](notes/gate-card-emergency-services.md).

- Emergencies (`POST /emergencies`, `GET /emergencies/{id}`, `GET /me/emergencies`, `POST …/cancel`, `POST …/on-my-way`): never rate-limited, one open per unit and type (a repeat answers 200 with it); every guard on shift and responder gets a critical push, the family a generic one; nobody accepting in two minutes escalates to the management.
- The responder is a first name and the gate's phone; `minutesAway` counts down from the minutes they picked (no GPS).
- `GET /units/{unitId}/emergency-contacts`: the family (for those who live there), the gates' phones, the office, duty and emergency numbers.
- Gate services (`POST /accessibility-requests`, `/security-reports`, `/escort-requests`, `/lane-requests`, each with `unitId`; `GET /me/gate-services`, `GET /gate-services/{id}`, `POST …/cancel`): for those who live in the unit, 3 open per kind and 20 a day per unit.
- `GET /community/places`: requests take place ids.
- The guard: `/gate/emergencies` and `/gate/gate-services`, inside a shift.
- The clinic (C5, C6) is not built: hide it.

### Permits and contractors (ADR 0049)

The full notes for the mobile team, with examples, are in [`notes/permits.md`](notes/permits.md).

- `GET /community/permit-rules`: the compound's work days, hours and days off, its time zone and the limits.
- The unit's primary asks for works (`POST /units/{unitId}/permits/works`), a furniture move (`…/moves`) and taking materials out (`…/material-exits`); anyone who may invite visitors holds an event (`…/events`, approved at once up to 20 guests, the management decides 21–150).
- Contractor workers are added one by one (`POST /permits/{id}/workers`): a name, a face (`contractor_photo`), the ID type and the last four of its number, never shown again.
- `GET /units/{unitId}/permits`, `GET /permits/{id}`, `POST /permits/{id}/cancel`; guests are added and taken off until the event starts.
- The guard: `GET /gate/unit-permits` (by unit code or reference) and `GET /gate/unit-permits/{id}`, then `POST /gate/entries` with `permit_worker` (plus `idLast4`), `event_guest` or `move_permit`; `POST /gate/unit-permits/{id}/use` for goods going out; `POST /gate/material-entries` for materials coming in.

### Gate card — guard shifts and tasks (ADR 0050)

The full notes for the guard app are in [`notes/guard-shifts-tasks.md`](notes/guard-shifts-tasks.md).

- `POST /gate/shifts/start` takes a `gateId` or a `zoneId` (a place). In a zone the gate's actions answer 403 `SHIFT_NOT_AT_GATE`. `ShiftView.gateId` is nullable and the view gains `zone`, the slot's times, `lateMinutes` and `pendingHandovers`.
- `POST /gate/shifts/end` takes the handover: every active checklist item (`GET /gate/handover-items`) and optional notes; the next guard acknowledges (`/gate/handovers/pending`, `…/{id}/acknowledge`).
- The roster: `GET /gate/roster` and `…/attendance` for the guard; `/staff/security/roster/*`, `/attendance`, `/posts`, `/guards` for the management. Late is more than 10 minutes, absent not opened by 60; overtime only for scheduled shifts.
- `GET /gate/my-work`: tasks, the gate services queue and mine, open parking reports (the guard role now closes them), pending instructions.
- Tasks (`/gate/tasks/{id}`, `…/take`, `…/complete`; `/staff/security/tasks`), swaps (`/gate/swaps`, `/staff/security/swaps`), instructions (`/gate/guard-instructions`, `/staff/security/instructions`), found items (`/gate/found-items`, `/staff/security/found-items`).
- `GET /staff/security/reports/daily` and `…/export` (CSV). `visitors` is passes and gate requests only; the permits' traffic (ADR 0049) has its own counts: `contractorWorkers`, `eventGuests`, `moveTrucks`, `materialEntries`, `materialExits`.
- `GET /units` is open to the security supervisor (`units.directory`, new, staff only): every unit of the compound, the same view the manager gets. `GET /units/{id}` and the unit's other routes stay `403`.

### Governance (ADR 0051)

The full notes for the mobile team, with examples, are in [`notes/governance.md`](notes/governance.md).

- For the units' owners only (`GOVERNANCE_NOT_AVAILABLE` for anyone else): `GET /governance/board`, `GET /governance/board/terms`, `GET /governance/publications`.
- Polls: `GET /governance/polls`, `GET /governance/polls/{id}`, `POST /governance/polls/{id}/votes` (once per unit, never changed; the answer never says what was chosen). On an open vote (`rollCallPublic: true`) say before the vote button that the unit's choice will be visible to owners after the close.
- Elections: `GET /governance/elections`, `GET /governance/elections/{id}`, `POST …/candidacy`, `POST …/candidacy/withdraw`, `POST …/votes` (up to `seats` candidates, always secret).
- A sitting board member holds `governance.board` (in `/me` → `permissions`): `POST /governance/polls`, `/governance/elections`, `/governance/publications`, their `PATCH` and `cancel` / `archive`.

### Gate card — patrols (ADR 0052)

The full notes for the guard app are in [`notes/patrols.md`](notes/patrols.md).

- The management: `/staff/security/patrols/checkpoints` (the QR payload answered once, at creation and at a reissue), `/staff/security/patrols/routes` (a change is `POST …/{id}/versions`), `/staff/security/patrols/runs` (detail, cancel, a run's track with `patrols.manage` only) and `/staff/security/patrols/report`.
- The guard: `GET /gate/patrols` (the board), starting a scheduled run (`/gate/patrols/runs/{id}/start`, the first wins) or one of their own (`/gate/patrols/routes/{id}/start`), scans and notes with the app's own UUIDv7 and the device's time, the track in batches, ending.
- `GET /staff/security/reports/daily` gains `patrols { scheduled, done, late, missed, incomplete }` per post; its CSV the five last columns `patrols_*`.
- A new file purpose `patrol_photo`, an export section `patrols/`, three notification kinds `patrol.*` (category `guard_duty`).

### Gate card — security operations (ADR 0053)

The full notes for the guard app are in [`notes/security.md`](notes/security.md).

- The guard: an SOS from the post (`POST /gate/emergencies`, one open per post and type), a lockdown (`POST /gate/lockdowns` with the typed `confirmation: "LOCKDOWN"`, `GET /gate/lockdowns/active`, overrides for emergency vehicles), the active blocklist (`GET /gate/blocklist`), an ID lookup (`POST /gate/id-lookup`, never stored), stop work (`POST /gate/unit-permits/{id}/stop-work`), incidents (`/gate/incidents`) and violations (`POST /gate/violations`).
- At a locked gate an entry in, a gate request and a material entry are 409 `LOCKDOWN_ACTIVE`, and the verify says `lockdown_active`; exits always go through. A banned plate or person is 409 `ENTRY_BLOCKED`, or `entry_blocked` at the verify; the verify's `display.blocklist` and the plate lookup's `blocklist` name the entry. `POST /gate/approval-requests` gains `vehiclePlate` and `idNumber`.
- Residents: a unit's violations (`GET /units/{unitId}/violations`, `GET /violations/{id}`, `POST /violations/{id}/appeal`, once within 30 days, a keeper or the primary), as its fines; a warning has `amount: null`. A visitor pass's detail gains `refusedBySecurity`. Residents get a generic critical `gate_lockdown.resident_notice` while the gates are locked, `visitor_pass.refused_by_security`, `unit_permit.work_stopped` / `work_resumed`, and `violation.*` (category `household`). Works permit views gain `workStopped`.
- The management: `/staff/security/lockdowns`, `/staff/security/blocklist`, `/staff/security/incidents`, `/staff/violations` and `/staff/violation-payments`, and the reports `/staff/security/reports/incidents` and `/violations` (JSON and CSV). `GET /staff/security/reports/daily` gains `incidents` and `violations` per post; its CSV the two last columns.
- Four new file purposes (`incident_photo`, `blocklist_photo`, `violation_photo`, `violation_appeal_photo`), export sections `incidents/` and `violations/`, five new permissions.
### Children (ADR 0054)

The full notes for the household app and the guard app are in [`notes/children.md`](notes/children.md).

- The household: `/units/{unitId}/children` (a minor's exit control, the card answered once at turn-on and at a reissue, the child's photo), `…/control/escorts` (adults of the home, its workers, or an outside person whose pickup code and link are answered once), and `/units/{unitId}/children/pickups` (the exits of the last 30 days).
- The outside person: `POST /public/child-pickups/lookup` (the token from the link's fragment; never a name).
- The guard: `POST /gate/children/verify` (the child's card: first name, photo, today's escorts; records nothing) and `POST /gate/children/exits` (who takes the child, or alone, or unidentified; refused means hold the child).
- The keepers: `GET /staff/security/child-alerts` and `…/{id}` (unauthorized pickups, never the child).
- Events gain `forChildren` with an age range and `PUT/DELETE /events/{id}/children/{memberId}`; a booking may name `occasionMemberId` on a facility with `childOccasions`.
- New file purposes `child_photo` and `child_escort_photo`, an export section `children/`, three notification kinds `child.*` (category `household`, two critical).

### Governance — board matters (ADR 0055)

The owners' side is in [`notes/governance.md`](notes/governance.md#appeals-to-the-board).

- Owners and primaries: appeals to the board (`POST /governance/board-appeals`, `GET` list and detail, `POST …/{id}/withdraw`), within 15 days of a staff decision and once per decision: a fine or a violation whose first appeal was upheld, the unit's booking suspension in force, or a rejected invoice dispute. Those four views gain `boardAppealUntil` and `boardAppealAt`. While the board has a fine or a violation it cannot be paid (`FINE_UNDER_APPEAL` / `VIOLATION_UNDER_APPEAL`, `params.level: "board"`). Overturned, a fine or a violation is cancelled and a suspension lifted as `board_overturned`.
- A sitting board member (`governance.board`): `/board/approvals`, `/board/appeals`, motions (`POST …/{id}/motions`, `/board/motions/{id}/votes`, `…/close`, `…/withdraw`) and `GET /board/overview`. Recused members get `403 BOARD_MEMBER_RECUSED`.
- The management: `/staff/governance/approvals` (`governance.approvals`), `/staff/governance/settings` and `/staff/governance/board-appeals` (`governance.manage`), `/staff/finance/budget-settings`, `/staff/finance/budgets`, `/staff/finance/expenses` and `/staff/finance/expense-authorizations` (`finance.budget`), and `GET /staff/finance/reports/budget-vs-actual` with its CSV (`finance.reports`).
- Three new file purposes (`approval_attachment`, `board_appeal_attachment`, `expense_invoice`), the export's `governance/board-appeals.json` and `governance/board-votes.json`, nine notification kinds (`governance_approval.*`, `governance_motion.proposed`, `governance_appeal.*`; category `governance`), and two new permissions.

### Gate card — guard completion (ADR 0056)

The full notes for the guard app and the management app are in [`notes/gate-completion.md`](notes/gate-completion.md).

- The guard: `POST /gate/field-exceptions` (ask the on-duty management to let someone in once; poll `GET …/{id}`, `…/withdraw`), then `POST /gate/entries` with `subjectType: field_exception`; `photoFileId` on a visitor's `in` (`visitor_photo`); `/gate/service-vehicles` (in, `…/{id}/exit`, inside now); `POST /gate/vehicle-passages` (a resident vehicle counted, never logged); `GET /gate/directory`; `POST /gate/incidents/{id}/signatures` (as the author). Instructions are seen and acknowledged on the days they hold.
- The management: `/staff/gate/field-exceptions` (the first answer wins), `GET/PATCH /staff/gate/settings`, `/staff/gate/reports/traffic` (JSON and CSV), `POST /staff/gate/log-search` (a visitor's exact name, the last 30 days), `GET /staff/gate/service-vehicles`, `GET /staff/security/patrols/runs/{id}/geofence-exits`, `…/incidents/{id}/signatures` (author or reviewer). Instructions gain `validFrom`, `validUntil` and `state`; a route version gains `geofence`; a pass gains `expectedMinutes`.
- Recordings on patrol notes and incidents (`mediaFileIds`): **the MP4 family only** (`audio/mp4`, `video/mp4`, `video/quicktime`), the length read from the container at finalize (`FILE_MEDIA_UNREADABLE`, `FILE_MEDIA_NO_DURATION`), within the gate's seconds and megabytes when attached (`MEDIA_TOO_LONG`, `FILE_TOO_LARGE`). The file view shows `durationMs`.
- New file purposes `visitor_photo`, `patrol_note_audio`, `patrol_note_video`, `incident_audio`, `incident_video`, `incident_signature`; incident evidence `patrol_track`; six notification kinds (`gate_exception.*` critical, `visit.overstayed*`, `patrol.geofence_exit`); two permissions (`gate_exceptions.decide`, `gate_log.search`); export files `patrols/geofence-exits.json` and `incidents/signatures.json`. `/gate/inside` is now `no-store`; the daily report gains `serviceVehicles` and a last CSV column.
### Gate card — the gate offline (ADR 0057)

The full notes for the guard app (what the mobile team implements: keys, the envelope, the clock, the bundle, tags, actions, uploads, heartbeat, vectors) and the management app are in [`notes/offline.md`](notes/offline.md).

- The guard device: `POST /gate/devices` (an Ed25519 key and its proof; the compound's, any guard may use it), `GET /gate/offline/keys`, and three signed-envelope routes: `POST /gate/offline/bundles` (a signed bundle for the shift, at most 24 h, no PII in clear), `POST /gate/offline/uploads` (up to 100 ordered actions, recorded at their device time, never refused, flagged), `POST /gate/offline/heartbeat`. Every response carries `serverTime` for calibration. A bundle or heartbeat envelope is accepted once (`GATE_DEVICE_ENVELOPE_REPLAYED`).
- Offline: visitor passes, derived worker cards, move trucks, event guests by plate or exact name, contractors by permit and ID last four, service vehicles, material entries, patrol scans, and children's exits (alone with leave, or a household adult with `idChecked: true`). Residents are "check ID" only.
- The management (`gate_devices.manage`, new): `/staff/gate/devices` (health, `notCarried`, revoke with `gateDeviceRevoke`), `/staff/gate/offline/flags` (review with `offlineFlagReview`), `/staff/gate/offline/batches` (a revoked device's quarantined batch accepted or rejected). The gate's settings gain `offlineSyncAlertMinutes`; child alerts gain `outcome` (`left_unverified`).
- Worker cards are now derived from `ENGAGEMENT_TOKEN_KEYS` (versioned); cards from before work online only until reissued. Seven notification kinds `gate_device.*` / `gate_offline.*` (three critical). `POST /gate/entries` with an `id` the device later uploads offline converges on one entry.

### The resident's side (ADR 0058)

The full notes for the household app are in [`notes/resident-decisions.md`](notes/resident-decisions.md).

- `GET /me/logins` (90 days, the device's label, never a place) and `GET /me/devices`, `POST /me/devices/{id}/revoke` (its sessions end; its next login alerts). `GET /me/sessions` gains `device`.
- The inbox: `?category=`, `?archived=true`, `POST /me/notifications/{id}/archive`, `/unarchive`, `DELETE /me/notifications/{id}`; items gain `archivedAt`.
- `GET /tickets/{id}/timeline` (`by` a side, never a name). Quotes: `GET /tickets/{id}/quotes`, `…/{quoteId}/approve`, `…/decline`; the dispatch's `GET`/`POST /maintenance/tickets/{id}/quotes`, `…/withdraw`. The start waits for an approved quote (`TICKET_QUOTE_NOT_APPROVED`).
- **`GET /me/requests` moved to core and widened** (disputes, permits, neighbour complaints), with `?state=open|closed`; items gain `kind` and `appeal`. A resident without either permission now gets an empty list, not 403. `GET /me/appeals`. `GET /me/search?q=` (references and the compound's names; 30 a minute).
- Topics gain `owner` (a role). `GET /management-office-hours`. A request on `release_request` names `about` (a ticket on hold, a stopped permit, the unit's credit).
- `GET /me/notices`, `GET /me/notices/{id}` (the first opening is the read proof). The staff: `/staff/finance/notice-settings` (the cure period), `GET /staff/finance/late-notices`.
- Credit notes gain `compensationReason` (reason `compensation`); `GET /payment-sessions/{id}` gains `alternatives`. Kinds `credit_note.issued`, `compensation.granted`, `payment.failed`, `formal_notice.issued`, `ticket.quote_*`.
- `GET /me/units/{unitId}/service-standing`: the services the unit is suspended from, and how to restore them.

### Partners (ADR 0060)

The full notes for the residents' app are in [`notes/partners.md`](notes/partners.md).

- Residents and family (`partners.request`): `GET /partner-categories` (13 categories, their sub-categories and consent codes), `GET /partners` (category, sub-category, open now, open late, new, favourites) and `GET /partners/{id}` (a suspended one with up to three `alternatives`), `PUT/DELETE /partners/{id}/favourite` (at most 50). `POST /partner-requests` needs the unit's `visitorsInvite` (`403 PARTNER_REQUEST_NOT_ALLOWED`) and the category's consent `partner_share_<category>` (`409 CONSENT_REQUIRED`); then `GET` list and detail, `…/cancel`, `…/accept-proposal`, `…/decline-proposal`, `…/done`, `…/no-show`, `…/rating`, `…/complaint` (a management request on the system topic `partner_service`, which the topics list never shows).
- The partner's desk (public, `/p#<token>` in `apps/public`): `POST /public/partner-desk/lookup` and `…/requests/{id}/accept|decline|propose|done|cancel`, the token in the body, rate-limited per IP and per token. Every link that opens no desk (unknown, revoked, expired, suspended) is the same `404 PARTNER_DESK_NOT_FOUND`. The desk sees a unit's code, a first name, the window, the note and the lines while the consent holds, and the gate pass from two hours before the window.
- The management (`partners.manage`, new): `/staff/partners` (with services, hours, prices, suspend, reinstate), `/staff/partners/{id}/desk-link` (made or rotated, shown once; `…/revoke`), `/staff/partner-subcategories`, `/staff/partner-settings`, `/staff/partner-requests` (the relay), `/staff/partner-complaints` (decided once), `/staff/partner-ratings`.
- An accepted request with `gatePass` gets the gate's own visitor pass for the requester (`passId`), cancelled with the request (`service_cancelled`). A new notification category `partners` with nine kinds (`partner_request.*`, `partner_complaint.decided`, `partner.suspended`), 13 consent codes, two permissions, and the export's `partners/requests.json` and `partners/favourites.json`.

### Appeals and the owners' voice (ADR 0059)

The full notes for the apps are in [`notes/appeals-and-voice.md`](notes/appeals-and-voice.md).

- `POST /decision-appeals` (`permit_rejection`, `vehicle_rejection`, `worker_rejection`, `neighbour_notice`; 15 days, once), `GET`, `GET /{id}`, `POST /{id}/withdraw`. The deciders: `/staff/decision-appeals`, `…/{id}/decide` (never the one who decided; an overturn runs the normal approval, else `follow_up` with its reason), `…/{id}/followed-up`. `GET /me/appeals` gains `decision_appeal` and `appeal.deciderRole`.
- Board appeals gain the kinds `management_appeal` and `management_complaint` (`POST /governance/management-complaints`, three open per owner); the staff's view has a nullable `unitCode`.
- `GET /me/representatives`, `…/{id}/messages`; the representative's `/me/representation/threads`; the board's `/board/representatives` and its matters `/board/representatives/matters` (raised, then decided by motions; `…/buildings`, `…/candidates`); `GET /staff/governance/representatives`.
- `/governance/agenda-proposals` and the board's `/board/agenda-proposals/{id}/decide`.
- `POST /governance/publications/{id}/objections`, `GET /governance/objections`; the board's `/board/publications/{id}/objections`, `…/answer`. Publications gain `objections` and `followUp`; settings gain the `objection` row.
- `POST /staff/governance/approvals/{id}/progress`; approvals gain `progress`.
- A neighbour notice gains `withdrawnAt`. New permission `appeals.decide`.

### The resident's unit on paper (ADR 0062)

The full notes for the apps are in [`notes/unit-and-contracts.md`](notes/unit-and-contracts.md).

- **Self contact.** `POST /me/contact/email` (step-up; a code to the new address) and `…/verify` (`profile.contact`, new). The old address is told. Name and phone are requests the management decides: `GET/POST /me/identity-changes` (step-up, one pending), `…/{id}/cancel`; the management's `GET /identity-changes`, `…/{id}/approve|reject` (`residents.manage`).
- **A registrant's page** (public, `/rs#<token>` in `apps/public`, emailed when they register): `POST /public/registrations/status`, `…/uploads`, `…/documents/{id}/finalize|remove`, `…/resubmit`, the token in the body, rate-limited per IP and per token, one `404 REGISTRATION_STATUS_NOT_FOUND`, dead once decided. At most 3 proofs (`registration_document`, 10 MB). The management's `GET /registrations` gains `status`, `documents` and `correctionCodes`; `GET /registrations/{id}/documents/{documentId}`; `POST /registrations/{id}/request-correction {codes}` (status `needs_correction`).
- **Household.** Invites take `kinshipDocuments` (at most 2, purpose `kinship_proof`; setting `familyKinshipProof`); pending members show them; `GET /household/invites|members/{id}/kinship-documents/{documentId}`. Delegation scopes `permits` and `documents`.
- **The vault.** `/units/{unitId}/documents` (`GET`, `POST`, `GET /{id}`, `POST /{id}/delete`) for residents, levels `private|owners|occupants`; `/staff/units/{unitId}/documents` for the management (`unit_documents.manage`, new), which never sees residents' own uploads.
- **The compound's documents.** `GET /compound-documents`, `…/versions?kind=`, `…/versions/{id}` (`community.read`); `GET /staff/compound-documents` and `POST /staff/compound-documents/versions` (`content.manage`, new). Bylaws cite the board's published decision.
- **Contracts.** `GET /me/contracts`, `GET /units/{unitId}/contracts/{id}`, `…/end-options`, `POST …/renewal-requests`, `POST /contract-renewals/{id}/withdraw`; the management's `/staff/units/{unitId}/contracts`, `/staff/contracts/{id}/void`, `/staff/contract-renewals`, `…/{id}/decline` (`contracts.manage`, new). Settings gain `renewalFee` and `moveOutFee`.
- **Clearances and deposits.** `POST/GET /units/{unitId}/clearances` (`409 CLEARANCE_BALANCE_DUE {owed}`), `GET /clearances/{id}/certificate` (PDF); `POST /public/clearances/lookup {code}` (`/c` in `apps/public`); staff issue with `finance.invoice`. `GET /me/deposits`, `POST /deposits/{id}/refund-request[/withdraw]`; the management's `/staff/deposits` (`deposits.manage`, new), `/staff/units/{unitId}/deposits`, `/staff/deposits/{id}/settle` (`finance.refund` + step-up). Payment method `deposit_offset`; deletion blocker `deposit_held`.
- **Files.** Purposes `registration_document`, `kinship_proof`, `unit_document`, `compound_document`, `contract`. Notifications `account.identity_change_decided`, `compound_document.published`, `contract.expiring`, `contract.renewal_decided`, `unit_document.warranty_expiring`.

### Moving, the closed unit and its proxies (ADR 0063)

The full notes for the apps are in [`notes/moving-and-closed-units.md`](notes/moving-and-closed-units.md).

- **Moves.** `GET /units/{unitId}/moves`, `POST …/moves/move-out` (the residing primary), `GET …/moves/{id}` (with its checklist), `POST …/steps`, `POST …/cancel`; the management's `/staff/moves`, `/staff/moves/{id}`, `POST /staff/units/{unitId}/moves`, `…/steps`, `…/done`, `…/cancel` (`residents.manage`). `POST /occupancies/{id}/handover` takes an optional `reasonCode` (`MOVE_HANDOVER_REASON_REQUIRED` with no clearance). A move permit requires `direction`. Topics `utilities` and `unit_preparation`.
- **Closed mode** for the owner of a unit with no primary; cleared with the household.
- **Proxies.** `GET/POST /units/{unitId}/proxies` (an owner; the token once), `…/{id}/revoke`, `GET /me/proxy-units`, `GET /staff/units/{unitId}/proxies`; public `POST /proxy-invites/accept/start|complete` (`/x` in `apps/public`). A new account type `proxy` and role `unit_proxy` (`access:sync`); capabilities gain the subject `proxy`.
- **Inspections.** `POST/GET /units/{unitId}/inspection-requests`, `…/{id}/cancel`, `GET /units/{unitId}/inspections` (no-store); `GET /staff/security/inspection-requests`, `…/{id}/cancel` (`guard_tasks.manage`); `POST /staff/security/tasks` takes `requestId`.
- **Works completion.** `POST /permits/{id}/completion-inspection`, `GET …/completion-inspections`, `GET …/completion-certificate` (PDF); `GET /staff/permit-inspections`, `…/{id}/decide`, `…/{id}/certificate` (`permits.manage`); public `POST /public/works-certificates/lookup` (`/w`). File purpose `works_inspection_photo`. A finishing-works deposit's view gains `worksCompletion`.
- **Lists and export.** `/me/requests` and `/me/search` gain `inspection_request` (`IR-`) and `works_inspection` (`WC-`). The personal-data export gains the unit's papers: contracts, vault documents, registrations, moves, proxies, clearances, deposits, inspection requests.


### Money and the unit (ADR 0069)

The full notes for the apps are in [`notes/money-and-unit.md`](notes/money-and-unit.md).

- **Consumption.** `GET /units/{unitId}/consumption` and `…/consumption/benchmark` for whoever lives there (capabilities gain `consumptionView`; a landlord is `403 CONSUMPTION_NOT_ALLOWED`), over the household's own tenure; push `meter.unit_spike` (category `utilities`). A compound document kind `saving_tips`.
- **Outages.** `GET /me/daily-brief` gains `outages`; `GET /me/outages` drops `note`.
- **Fees.** `GET /units/{unitId}/fees`, `GET /invoices/{id}/comparison`; a billing plan's `descriptionEn/Ar`, `decisionPublicationId` on a new amount, `GET /staff/billing-plans/{id}/amount-changes`.
- **Where the fees went.** `GET /finance/spending-reports`, `…/{id}` (every payer); `GET/POST /staff/finance/spending-reports`.
- **Plan decisions.** Accepting or declining a request whose invoice no longer owes or was split is `409 PLAN_REQUEST_LAPSED`.
- **Receipts.** `GET /payments/{id}/receipt`, `GET /staff/payments/{id}/receipt` (PDF, no-store).
- **Plans.** `POST /invoices/{id}/plan-requests`, `GET /plan-requests/{id}`, `…/withdraw`; `GET /staff/plan-requests`, `…/{id}`, `…/accept`, `…/decline`; `GET/PATCH /staff/finance/plan-settings`. An invoice's detail gains `planOffer`.
- **Upcoming dues.** `GET /units/{unitId}/upcoming-dues`; push `finance.dues_rising` when turned on.
- **Collectors.** A staff role `collector` (`finance.collect`, `access:sync`); `POST/GET /units/{unitId}/collector-visits`, `/collector-visits/{id}/cancel|accept-offer`; `/staff/collector-visits`, `…/{id}/assign|cancel`, `GET /staff/collectors`, `GET/PATCH /staff/finance/collector-settings`; the collector's `GET /collector/visits`, `…/{id}/collected|failed` (`400 AMOUNT_TOO_HIGH {max}`).
- **Lists.** `/me/requests` gains `instalment_plan_request` and `collector_visit`.
