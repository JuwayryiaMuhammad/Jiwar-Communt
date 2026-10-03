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
