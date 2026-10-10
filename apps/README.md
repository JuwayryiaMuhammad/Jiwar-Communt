# Dashboards

Two Next.js 16 dashboards for this backend, in the same pnpm workspace (`pnpm-workspace.yaml` at the repo root):

| App | Port | Who | Sign-in |
|---|---|---|---|
| `apps/admin` | 3001 | Platform super admin | Email + password (`/platform/auth/*`), forced password change on first sign-in |
| `apps/manager` | 3002 | Compound manager, maintenance supervisor | Email or phone → 6-digit code by email → pick the account. Admitted: managers, and any role holding `tickets.dispatch` or `maintenance.manage` (read from `GET /me` at sign-in); anyone else is signed out at once and shown "No access" |

Both follow the design system in `docs/decisions/DESIGN.md`. The tokens live in `packages/ui/src/styles.css`.

```
apps/admin        super admin: compounds, managers, security events, platform audit, account
apps/manager      manager: overview, requests, units, residents, workers, maintenance, gate, staff, roles, settings, audit
apps/Dockerfile   one image per app (--build-arg APP=admin|manager), Next.js standalone output
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

- A ticket opened for a resident takes its reporter from the unit's occupants, or for a common area from the first 100 residents: household members with a login are not listed anywhere a manager can pick them from.
- The ticket list filters one status at a time, so the "Open" view hides finished tickets on the pages loaded so far.

- No count endpoints: overview numbers come from one page of up to 100 rows and show `100+` beyond that.
- No unit search: the unit picker lists the first 100 units by code.
- Managers cannot read `GET /gate/inside` (it needs `gate.operate`, which only guards have), so the overview shows today's entries instead of who is inside.
- A unit's workers (`GET /units/:id/workers`) and closed mode need `workers.manage` / `household.manage`, which only residents have, so the unit page leaves them out.
- The client's IP reaches the API as the BFF's IP (no `X-Forwarded-For` is forwarded). Set it up at the reverse proxy if security events need the real client IP.
- English only for now. Error texts are keyed by API error code in `packages/api/src/errors.ts`, ready for an Arabic dictionary.

## Checks

```bash
pnpm dashboards:typecheck
pnpm dashboards:test     # BFF (refresh, same-origin, user agent) and the manager's access rule
pnpm dashboards:build
```
