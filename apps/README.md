# Dashboards

Two Next.js 16 dashboards for this backend, in the same pnpm workspace (`pnpm-workspace.yaml` at the repo root):

| App | Port | Who | Sign-in |
|---|---|---|---|
| `apps/admin` | 3001 | Platform super admin | Email + password (`/platform/auth/*`), forced password change on first sign-in |
| `apps/manager` | 3002 | Compound manager, maintenance supervisor | Email or phone → 6-digit code by email → pick the account. Admitted: managers, and any role holding `tickets.dispatch` or `maintenance.manage` (read from `GET /me` at sign-in); anyone else is signed out at once and shown "No access" |

Both follow the design system in `docs/decisions/DESIGN.md`. The tokens live in `packages/ui/src/styles.css`.

```
apps/admin        super admin: compounds, managers, security events, platform audit, account
apps/manager      manager: overview, requests, units, residents, workers, maintenance, gate, parcels, staff, accounts, roles, settings, maintenance setup, deletion requests, audit, notifications, own account
apps/public       the public web pages the API's links open (port 3003); not a dashboard, see apps/public/README.md
apps/Dockerfile   one image per app (--build-arg APP=admin|manager|public), Next.js standalone output
packages/ui       design tokens + components (shell, cards, tables, dialogs, forms, toasts)
packages/api      types generated from docs/api/openapi.v0.json, typed client, error texts, React data hooks
packages/bff      server-only: cookie session, /bff proxy, single-flight token refresh, CSRF guard
```

## Run

With Docker, `docker compose up -d --build` at the repo root starts the API and both dashboards (root README).

On the host, against an API on the host or in Docker:

```bash
pnpm install                                         # at the repo root, once
cp apps/admin/.env.example apps/admin/.env.local     # JIWAR_API_URL, e.g. http://localhost:3100
cp apps/manager/.env.example apps/manager/.env.local
pnpm dev:admin       # http://localhost:3001
pnpm dev:manager     # http://localhost:3002
```

`JIWAR_API_URL` is the API origin without `/api/v1`, read on the server only.

After an API change (`pnpm openapi:export`), regenerate the client types; CI fails while they are stale:

```bash
pnpm api:generate
pnpm dashboards:typecheck
```

## How the dashboards talk to the API (BFF)

The browser never holds a token and never calls the API. Each app has a backend-for-frontend under `/bff`:

- `/bff/auth/*`: sign-in, sign-out and session routes. Tokens go into httpOnly cookies: the access token and refresh token are scoped to `/bff`, and a secret-free marker cookie on `/` lets `proxy.ts` send signed-out visitors to `/login`.
- `/bff/api/v1/...`: forwards an allow-listed call with `Authorization: Bearer`. The admin app forwards `/api/v1/platform/*` only (not `platform/auth`). The manager app forwards everything except `platform`, `auth`, `public` and the public invite and registration flows. A path with `.` or `..` segments gets 404. Error bodies are passed through without the API's developer `message` and `path`.
- **Refresh.** The API rotates refresh tokens and revokes the session when a rotated token comes back (reuse detection, ADR 0004). The BFF therefore refreshes each token once (single flight). For 30 s afterwards it hands the same result to late requests that still carry the old cookie. A 401 is retried once after a refresh; the auth guard rejects before any handler runs, so the retry cannot repeat a side effect. The refresh state is per process, so run one BFF instance per app or use sticky sessions.
- **CSRF.** Every `/bff` call must carry `x-jiwar-bff: 1`, a custom header that forces a CORS preflight the BFF never answers. Non-GET calls must come from the same `Origin`. Cookies are `SameSite=Lax`, or `Strict` for the login ticket.

Because of the BFF, the API needs no `CORS_ORIGINS` for the dashboards.

## Permissions

`GET /me` returns the role's permissions. The shell shows a section only to a role that may read it, and asks for a queue's count only then (`lib/permissions.tsx`: `usePermissions`, `Can`). This is for showing and hiding; the API decides every call, and a 403 renders as "No access" where it lands.

## Known limits (API v0)

- A ticket opened for a resident in a common area takes its reporter from the first 100 residents (for a unit, the API lists who may report there).

- No count endpoints: overview numbers come from one page of up to 100 rows and show `100+` beyond that.
- No unit search: the unit picker lists the first 100 units by code.
- Managers cannot read `GET /gate/inside` (it needs `gate.operate`, which only guards have), so the overview shows today's entries instead of who is inside.
- A unit's workers (`GET /units/:id/workers`) and closed mode need `workers.manage` / `household.manage`, which only residents have, so the unit page leaves them out.
- The client's IP reaches the API as the BFF's IP (no `X-Forwarded-For` is forwarded). Set it up at the reverse proxy if security events need the real client IP.
- A file is uploaded by the browser straight to object storage with a presigned URL (`components/file-upload.tsx`), so the bucket must allow the dashboard's origin (CORS: `PUT`, headers `Content-Type` and `If-None-Match`) and its URL must be reachable from the browser. Photos shown on a page come from presigned URLs the same way.
- A wage has no currency: the API does not name the compound's, so amounts show as plain numbers. Wage payments and closing a wage obligation are for manager accounts only (the API refuses a staff role, whatever it holds), so a staff reviewer sees the monthly wage and the open obligation without them.
- Requests to the management (ADR 0039): the inbox, a request's page, the appointments agenda and "Requests setup" need `requests.handle` or `requests.manage`; an account holding only one of them may sign in. Opening a request for a resident also needs `residents.read` and `units.read` (the resident is found through their unit, from the first 100 units). A request has no subject, so the inbox shows the start of its first message. Appointment slots are shown in the browser's time zone, the office hours are set in the compound's.
- Community life (ADR 0040): Announcements (with works and closures), Events and Polls need `community.publish`; Suggestions needs `community.suggestions`; "Community setup" shows the tab of whichever the account holds. An account holding only one of the two may sign in. Dates are typed and shown in the browser's time zone; "today" in the residents' daily brief is the compound's. A composer's audience count is of that moment: an audience is read again each time a resident opens the content. Read counts and poll results are counts only: there is no list of readers or of who chose what to show, by design; an open poll's counts stay hidden until five units have voted. Attachments are added one file at a time (up to five) and a removed one is dropped from the next version only. The dashboard has no rich text: titles and texts are plain, in English, Arabic or both.
- Neighbours (ADR 0042): Complaints, "Lost & found" (with the lending board) and "Conversation reports" need `neighbours.handle`, and an account holding only that may sign in; "Neighbours setup" needs `neighbours.manage`. A complaint has three threads that never mix — with the complainant, with the unit complained about (it opens with the one notice, whose text is the only thing the unit ever reads) and internal notes — each with its own compose box. The inbox's unit filter needs `units.read` and lists the first 100 units; its category filter lists active categories only. Only a found item is claimed and handed over; handing one to a resident who came without a claim picks them from the first 100 residents (`residents.read`) or takes a pasted account id. The lending board is read-only apart from removing a post, and no conversation between residents is reachable except as a reported case, which is readable only while the case is open. The welcome is written in English, Arabic or both, each language filled in completely or left empty.
- Facilities and the club (ADR 0044): "Facilities" needs `facilities.manage` (or `bookings.handle` to read it and its closures); "Bookings", "Approvals" and "Suspensions" need `bookings.handle`; "Memberships" needs `club.billing` and "Plans" `facilities.manage` or `club.billing`. An account holding only one of them may sign in; the accountant role holds `club.billing` alone. The day view shows one facility's local day in the browser's time zone (the compound's, in practice) and lists bookings that fit none of today's slots apart. Approving refuses past the slot's capacity as it is now. A closure's times are picked in the browser's local time. Memberships are listed whole (one per unit), not paged; a unit is found by its exact code. Staff cannot book on a resident's behalf, and there is no online payment.
- Topic names are entered in English and Arabic (the residents' app shows the Arabic one); the Arabic field is the only right-to-left input.
- English only for now. Error texts are keyed by API error code in `packages/api/src/errors.ts`, ready for an Arabic dictionary.

## Checks

```bash
pnpm dashboards:typecheck
pnpm dashboards:test     # BFF (refresh, same-origin, user agent); the manager's access rule, notification texts and session names
pnpm dashboards:build
```
