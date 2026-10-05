# API v0 notes

API v0 is a draft (ADR 0025): it exposes every feature so it can be exercised end to end, before the design exists. This file lists what is known to change.

## To reshape with design

- `GET /units` is ordered by `createdAt`; managers will likely want `code` order and search.
- `GET /me` omits the holder's own birth date; add it if the profile screen shows it.
- `GET /units/:unitId/household` is an object (`members`, `invites` for its managers), not a list; the screens decide whether invites get their own endpoint.
- `GET /units/:unitId/deferred-actions` leaves out `payload`: no domain submits deferred actions yet; the decision screen will say what it shows.
- `GET /worker-engagements/:id` was added so a manager can attest a passport worker's birth date; the review screen may want the worker's other engagements.
- Lists name people by id only where a name would need a join the screen may not want: compliance cases (`workerId`), card incidents (`workerId`), erasures (`accountId`), audit entries (`actorId`, `targetId`).
- `GET /registrations` computes conflicts per request, row by row; fine for a review queue, to revisit if the screen shows many at once.
- A card incident's `note` is readable nowhere in v0; the incident screen decides who sees it.
- Capabilities without endpoints yet (finance, governance, bookings, documents) are flags only.
- Worker in/out notifications go to every residing member, twice a day; per-account notification preferences come with the design.
- Gate entries may be backdated up to 24 h (offline readiness); the manager's entries screen should highlight a large gap between `occurredAt` and `recordedAt`.
- `GET /me/gate-requests` is bounded (the pending requests of the caller's units); `GET /gate/inside` is paged by entry time. Both may want a push channel rather than polling once the apps exist.
- `POST /gate/verify` returns one `display` object for visitors and workers (fields of the other kind are null); the guard screen may want two shapes.
- The visitor's page is two POSTs (`/public/visitor-passes/lookup`, `/not-me`) so the token never sits in a URL; the web app reads it from the link's fragment (ADR 0030).
- A pass's `link`, `qrPayload` and `code` come once, at creation or from `POST /visitor-passes/:id/reissue-link`; a host who loses the link reissues it, no need to cancel and recreate. There is no GET for a link or for a worker's card data (a lost card is a reissue).
- The worker card's `preferredLanguage` is always `ar` until worker registration takes a language.
- `POST /gate/verify` takes `code` or `qr`; the guard app may prefer a dedicated QR route once scanning has its own error states.
- A resident's entry QR (ADR 0031): `POST /me/entry-credentials` returns the secret once; the phone computes `JWR2.<id>.<step>.<mac>` offline every 30 seconds (the formula and test vectors are in the ADR). `GET /me/entry-credentials` shows only id, device name and creation time. The guard's `display` is one flat object for visitors, workers and residents; the guard screen may want three shapes.
- `GET /me` carries `photoUrl` (short-lived, no-store); the app re-reads it rather than caching it.
- Maintenance (ADR 0032) has one route family per audience (`/tickets`, `/technician/tickets`, `/maintenance/tickets`) with its own views; the screens may want them merged once they exist.
- Ticket actions answer 204; the apps re-read the ticket. A ticket's number (`MT-000123`) is in every view but is not searchable yet.
- Dispatchers (maintenance_supervisor) never see the reporter's phone; in an emergency they may need to call. Decide with the design whether emergency tickets show the reporter's phone to dispatchers.
- Every dispatcher is told of every message on every ticket (`ticket.message`); per-account preferences come with the design.
- A rejection's or reopen's note shows up as the reporter's message in the thread, not as a field of the ticket.
- Photos are never removed from a ticket in v0, and a ticket's list has no photo; the detail carries presigned URLs (no-store).
- Dispatch (ADR 0033): automatic dispatch is off in every compound until the manager turns it on in `PATCH /maintenance/dispatch-settings`. The settings screen should show **how many available technicians have specialties** before the manager enables it (`GET /maintenance/technicians` has what it needs): with none, every new ticket is `no_candidate` and every dispatcher is told.
- Turning dispatch on assigns up to 50 queued tickets right away, after the answer (the screen re-reads the queue shortly after); the rest waits for the next sweep (hourly by default) or a dispatcher's `POST /maintenance/tickets/:id/auto-assign`, which answers 503 `DISPATCH_BUSY` if the compound's dispatch lock stays held (try again). The screen may want a "dispatch the queue" button that calls it per ticket.
- A technician's availability history is readable nowhere in v0; `GET /maintenance/technicians` shows the current state and when it changed. `workload` is in points with two decimals (status weight × priority multiplier over assigned, in-progress and on-hold tickets).
- `GET /maintenance/tickets/:id/dispatch-attempts` answers "why wasn't this assigned?"; the screen decides how much of it to show.
- Specialties are read by dispatch (`tickets.dispatch`) and written by the manager (`maintenance.manage`); a supervisor who is not also a manager cannot change which specialties a category needs.
- Visits (ADR 0034) have one route family per audience like tickets, plus `GET /me/units/:unitId/visits` for every adult who lives in the unit. Visit actions answer 204 (a proposal, counter or reschedule 201 with the new visit's id and window); the apps re-read the list. The resident app should present absence-entry consent as its own step after confirming, never as part of it, and show who granted it.
- A visit's window is checked against the database's clock: an app whose clock is off may see `VISIT_TOO_SOON` for a time that looks 15 minutes away.
- A worker receiver is `{ engagementId }`; the app lists the unit's active workers from `GET /units/:unitId/workers`. A worker whose engagement ends stops showing as receiver at once.
- The SLA (ADR 0034) is off in every compound until the manager turns it on in `PATCH /maintenance/sla-settings`; turning it on starts the open tickets' clocks over the next seconds (the screen re-reads), never backdated. Targets are per category and priority (`PUT /maintenance/categories/:id/sla-targets`, all three priorities at once). Residents see `sla` (due times, paused) on a ticket; dispatch also sees the states and `GET /maintenance/tickets/:id/sla-events`. The dispatch list has no SLA filter yet.
- The residents confirm a technician's arrival with `POST /tickets/:id/visits/:visitId/confirm-arrival` (ADR 0038), once, on an `arrived` visit. The app shows the button while `status` is `arrived` and `arrivalConfirmedAt` is null; nothing waits for it.
- `en_route` (ADR 0038) is a ticket status between `assigned` and `in_progress`, sent by the technician app with `POST /technician/tickets/:id/en-route`. It is optional: `start` still works from `assigned`. Apps that switch over `status` must show `en_route` ("technician on the way"); it allows every action `assigned` allows.

- **Preferences** (ADR 0036): `GET/PATCH /me/notification-preferences` returns every category with both channels, quiet hours and the pause. `push` is stored but not read until push delivery exists. A PATCH changes only what it names; pause choices are `1h`, `8h` and `until_resumed`, and `null` ends one. The settings screen should say which notifications always arrive (critical).
- **Consents:** `POST /me/consents/grant` takes the version of the text the app showed; a stale app gets `CONSENT_VERSION_MISMATCH` with `params.current` and should show the new text. The technician's `reporterPhone` may turn null between two reads (revoked, or the work done).
- **Step-up:** `POST /me/step-up`, then `/verify` with the emailed code, then the sensitive action on the same session within 10 minutes. One code opens one action.
- **Exports:** `POST /me/data-exports` answers `pending`. The archive is ready when the inbox says so (`data_export.ready`, no link), and `GET /me/data-exports/{id}/download` gives a short-lived URL to open at once. An assisted export's email link opens a web page that calls `POST /public/data-exports/code`, then `/download` with the emailed code, at most three times.
- **Deletion:** `POST /me/deletion-request` may answer 409 `DELETION_BLOCKED` with `params.blockers`; the app should explain each and what clears it. A request can turn `queued` after its cooling-off; the managers' screen is `GET /erasures` with `POST /erasures/{id}/erase` or `/close`.
- **Unusual login:** apps must send `X-Jiwar-Install-Id` (a UUID made once per install) on `POST /auth/select-account`, or every login looks like a browser. The alert's in-app action is `POST /me/devices/{targetId}/not-me`, and the email's is the web page below; both freeze the account and end every session, the caller's included.
- **The email link pages (ADR 0036): a contract the web app must implement. Until it exists, the links in the unusual-login and assisted-export emails do not work.** The token is only in the fragment, and the page posts it in a body:
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
- **Assisted:** the management screens use `/accounts/{id}/…` with a `reasonCode` on every write; the account is always told.
