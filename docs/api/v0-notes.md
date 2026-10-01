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
- Capabilities without endpoints yet (finance, governance, bookings, tickets, documents) are flags only.
- Worker in/out notifications go to every residing member, twice a day; per-account notification preferences come with the design.
- Gate entries may be backdated up to 24 h (offline readiness); the manager's entries screen should highlight a large gap between `occurredAt` and `recordedAt`.
- `GET /me/gate-requests` is bounded (the pending requests of the caller's units); `GET /gate/inside` is paged by entry time. Both may want a push channel rather than polling once the apps exist.
- `POST /gate/verify` returns one `display` object for visitors and workers (fields of the other kind are null); the guard screen may want two shapes.
