# 0025 — HTTP API v0: a draft over the services

**Status:** Accepted · Phase 3

## Context
Phases 1a to 2.2 built every feature as a service with service-level tests, and deliberately added no HTTP endpoints: the screens come from a Figma design that is not ready. The features now need to be exercised end to end. The API is built so that reshaping it screen by screen later is cheap and safe.

## Decisions
- **A draft, marked as such.** Every operation carries `x-stability: draft` and one area tag. The contract is `docs/api/openapi.v0.json`, written by `pnpm openapi:export` (Nest preview mode, no infrastructure); a test fails when it is stale, so every API change is a reviewed diff. `@nestjs/swagger`'s CLI plugin is off: DTOs and views carry explicit `@ApiProperty`, so `nest build`, ts-jest and ts-node produce the same document. What is known to change is listed in `docs/api/v0-notes.md`.
- **Thin controllers.** A controller validates input, calls one service method and maps the result through a view in `<module>/views/`. Views whitelist fields; no Prisma entity is ever returned. Rules, resource checks, capabilities, audit, reasons and error codes stay in the services. Where an endpoint needed something a service did not have, the method was added to the service with its own service test.
- **Shape.**
  - `/api/v1`, resource-oriented; actions are `POST /resource/:id/<verb>`; no `DELETE` with a body. Creates answer 201, actions with a body 200, void actions 204.
  - Lists: `?cursor=&limit=` (1–100, default 20) → `{ data, nextCursor }`. Every cursor is the same opaque `(timestamp, id)` keyset (`keysetCursor`, newest first by default, `asc` for review queues). Bounded collections (a unit's household or delegations, my sessions, the roles, the permission catalog…) have the same shape with `nextCursor: null` and take no cursor.
  - Reasons: `{ reasonCode, reason }`. The DTO checks types only; presence and the closed list stay with the service, so `REASON_REQUIRED` and `INVALID_REASON_CODE` (with `allowed`) are the same over HTTP and in-process.
  - Unknown body and query fields are `FIELD_NOT_ALLOWED`.
- **Access.**
  - Tenant routes: the tenant guards and `@RequirePermissions`; `@RequireAnyPermission` where an action is open to two roles and the service's resource check decides the rest (worker engagement actions: a resident's `workers.manage` or a manager's `workers.review`). Declaring both on one route fails when the class loads.
  - Platform routes live under `/platform` with `@PlatformAuth`; the restricted first-login token opens only `change-password`.
  - Public routes are `@Public` and rate-limited with the existing limiters (invite completion gained a per-IP limit).
  - Another compound's id, or a resource the caller cannot see, is a 404 with the resource's code, never a 403 that confirms it exists. `GET /me/units/:unitId/capabilities` is `UNIT_NOT_FOUND` when the caller has no place in the unit, and the primary-only unit actions check visibility first.
- **Capabilities are what the apps use.** `GET /me/units/:unitId/capabilities` returns the `capabilitiesFor` record; the apps show or hide features from it, and a suite keeps the endpoints consistent with it (allowed → 2xx, disallowed → 403/404). So `HOUSEHOLD_UNDER_REVIEW` (the death-review freeze) is a 403, not a 409: the capability already says the action is not allowed (decided 2026-10-01).
- **Personal data in responses.**
  - No identity-document number in any list; a manager's detail shows only the last four, masked (`••••1234`); the holder's own `GET /me` is masked too and has no birth date. Birth dates never appear in lists.
  - Residents and family never see other people's phone, email or document. The household shows names, relation, minor flag and status; the primary or a `household` delegate also sees each member's permissions and the pending invites (invitee name, relation, expiry).
  - Free-text reasons and notes are returned nowhere in v0 (they reach the person in notices and emails); codes are.
  - An erased account renders as `{ id, erased: true }` everywhere.
  - The compound's audit log has no IP or user agent; the platform's audit and security events do.
- **Secrets shown once** (access codes, invite and link tokens, session tokens) come with `Cache-Control: no-store`. They travel only in bodies, and the HTTP log options never serialize bodies and redact credentials.
- **Public enumeration.** Registration and invite acceptance answer every input with the same status, headers and body; only the error envelope's `requestId` and `timestamp` differ per request (ADR 0013), and a test compares everything else byte for byte.
- **Tests.** `test/api/routes/` is a registry with one row per endpoint: auth kind, the persona that lacks the permission, a foreign-id case with its code, invalid input with its exact field errors, and no-store. The matrix suite derives no token → 401, the other token kind → 401, missing permission → 403, foreign id → 404, invalid input → 400, and a malformed id → 400 `INVALID_UUID` for every row; the docs suite fails if Swagger and the registry disagree. Every area has a happy-path suite asserting the exact response key set; cross-API suites cover enumeration, a PII leak scan (five personas, every GET), capabilities, no-store, erased accounts and logs.

## Consequences
- Reshaping an endpoint for a screen touches a controller, a view, a registry row and the contract file, never a rule.
- Draft means unstable: clients must not rely on v0 shapes beyond the Figma prototypes.
- Paged service methods now return `Page<T>`; in-process callers read `.items`.
- **Phase 4 areas** (ADR 0027, 0028): `notifications` (`/me/notifications`), `gates` (management), `gate` (the guard: shifts, verify, entries, who is inside, approval requests), `visitors` (passes and gate instructions), `gate-requests` (the household's answers) and worker attendance under `workers`. The registry gained a `guard` persona; the PII scan reads every GET as six personas, the guard included (no resident or visitor name, ever); the capabilities suite probes `visitorsInvite` with a real pass. Gate writes honour `Idempotency-Key`; verify does not (read-only).
- **Phase 4.3 (ADR 0031):** the area `entry-credentials` (`/me/entry-credentials`: issue, list, revoke) and `PUT/DELETE /me/photo` under `me`. `GET /me` is now no-store (it carries the holder's photo URL). Verify's `display` gained `firstName`, `unitCodes` and `photoUrl`; `unitCode` is null for a resident. The registry has a row per new endpoint; the PII scan proves a resident's photo key appears only in the owner's `GET /me`.
- **Phase 5.1 (ADR 0032):** the areas `maintenance` (categories, settings, dispatch: `/maintenance/…`), `tickets` (the residents' `/tickets…` and `/ticket-categories`) and `technician` (`/technician/tickets…`). One view per audience. Ticket details are no-store (presigned photo URLs). Ticket creation and message posts honour `Idempotency-Key` and return no free text. The registry gained a `technician` persona; the PII scan reads every GET as seven personas, and the technician never sees a resident's full name or account id, who declined, a rating or comment, or a ticket not assigned to them. A ticket description, a common-area label, message bodies and confirmation comments are content: returned to those who may see the ticket, never in audit or notifications. A rejection's note is a message, not a field. The technician's message list names senders by first name without an account id, so an erased one is `{ erased: true }` there.
