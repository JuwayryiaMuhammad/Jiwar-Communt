# Public web pages

The pages the API's links open, served at `PUBLIC_APP_URL` (port 3003). Next.js 16, same tooling as the dashboards, but not a dashboard: no sign-in, no session, no cookie.

| Path | Link built by | What it does | API calls |
|---|---|---|---|
| `/v#<token>` | the API (`link` of an issued pass, ADR 0030) | The visitor's pass: QR (drawn in the browser from `qrPayload`), gate code, window, schedule, directions, status; "this pass is not for me" | `public/visitor-passes/lookup`, `public/visitor-passes/not-me` |
| `/p#<token>` | the management (a partner's desk link, ADR 0060), given to the partner once | The partner's desk: its live requests and those closed today, with the unit's code, a first name, the window, the note and the lines while the resident's consent holds; the gate pass from two hours before the window; accept, propose another time, decline, mark done, cancel, each after a confirming press | `public/partner-desk/lookup`, `public/partner-desk/requests/{id}/accept\|decline\|propose\|done\|cancel` |
| `/a/not-me#<token>` | the API (unusual-login email, ADR 0036) | Explains the freeze, asks to confirm, then freezes the account | `public/not-me` |
| `/a/export#<token>` | the API (assisted-export email, ADR 0036) | Sends a code to the same email, then opens the presigned download | `public/data-exports/code`, `public/data-exports/download` |
| `/i#<token>` | whoever holds the invite token (the residents' app) | Accepts a household invite with the emailed code | `invites/accept/start`, `invites/accept/complete` |
| `/r#<token>` | whoever holds the registration link token (the management) | Self-registration form, then the emailed code | `registrations/start`, `registrations/complete` |
| `/` | | App name and "download the app" placeholders | none |
| anything else, or a link without a well-formed token | | The invalid-or-expired page, without a request | none |

The contract is `docs/api/v0-notes.md`; the API is the source of truth.

## Run

```bash
pnpm install                                          # at the repo root, once
cp apps/public/.env.example apps/public/.env.local    # JIWAR_API_URL, e.g. http://localhost:3100
pnpm dev:public                                       # http://localhost:3003
```

Set the API's `PUBLIC_APP_URL=http://localhost:3003` so its links land here. With Docker, `docker compose up -d --build` at the repo root starts it with the rest.

## Rules the code keeps

- **The token.** Read from `location.hash` once (`components/use-link-token.ts`), checked against the shape the API issues (`lib/fragment.ts`), then removed from the address bar with `history.replaceState` before any request. It lives in component memory only: never in a URL, a query string, storage or a log. A reload loses it, on `/v` too, and the page asks the person to open the link again.
- **Same origin.** The browser calls only `/api/...` on this app (`app/api/[...path]/route.ts`), which forwards the fixed public POST routes and a partner desk's five actions on one request id (`lib/proxy-rules.ts`) to `JIWAR_API_URL`. The API needs no `CORS_ORIGINS` for it. The token travels in the JSON body. Bodies are never logged; the app has no `console` call.
- **Headers upstream.** `content-type`, `accept-language`, and `X-Forwarded-For` reduced to its right-most entry, the one the reverse proxy wrote, so the API's per-IP limits count the real client and a client-sent chain is ignored. Nothing else: no cookie, no authorization, no user agent. `Idempotency-Key` and `X-Jiwar-Install-Id` are not forwarded because none of these routes reads them. See `deploy/README.md` for why this needs the app and the API on localhost only.
- **Headers on pages** (`proxy.ts`, `next.config.ts`): a Content-Security-Policy with a per-request nonce and no third-party origin, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `frame-ancestors 'none'`. No analytics, no external font (system fonts), no inline style.
- **A confirming press before any change.** No request that changes or sends anything leaves on page load. The API has no way to check an email link without using it, so a dead link is only known after the press.
- **Arabic first.** `<html lang="ar" dir="rtl">`; the switch changes language in place, with no navigation. Copy is in `messages/ar.ts` and `messages/en.ts` (same keys, tested). The API returns codes, not text: `lib/errors.ts` maps them. The language choice alone is kept in `localStorage`.
- **Registration sends the form twice.** The emailed code is bound to the exact `start` body, so `complete` sends that same frozen object plus the code (`lib/registration.ts`).

## Known limits

- **Registration has no ID document upload.** The API has no upload path for a registrant (`/files/*` needs a signed-in account; ADR 0024 defers documents). The form takes the ID type and number as text.
- **The export download fails on staging** while storage is HTTP MinIO: the browser blocks an HTTP download from an HTTPS page, and the page cannot detect it, so it says the file service may be unavailable. It works once storage is HTTPS (`deploy/README.md`).
- **The pass has no gate status** beyond `status`: the API returns none. "Not started yet" and "outside visiting hours" are worked out in the browser from the window and schedule, in the compound's time zone (`lib/pass-status.ts`).
- **A dead invite or registration link is not told apart from a live one. This is correct by design, not a gap to fix here.** Both `start` routes answer the same, so the pages say "if the link is valid, a code was sent". A dead invite then refuses every code, and the page says "the code is wrong or has expired, or the link is no longer valid" (`OTP_INVALID` covers all three). A dead registration link still emails a code and answers "received" to it, writing nothing: the link is published (a QR at the gate), and the API deliberately says nothing about it (ADR 0024). The page repeats the API's answer; it must not try to find out more.

## Tests

```bash
pnpm --filter @jiwar/public test        # node --test: fragment, proxy rules, steps, pass status, errors, ar/en parity
pnpm --filter @jiwar/public typecheck
pnpm --filter @jiwar/public build
```

The browser smoke (`e2e/`, Playwright) is local only, not in CI. It drives the built app against an API that `test/web-smoke/serve.web-smoke.ts` boots on the test database and seeds with one link of every kind:

```bash
# 1. the API (jest, like an e2e suite; needs the test database, Redis, MinIO and Mailpit)
WEB_SMOKE_DIR=/tmp/web-smoke pnpm exec jest --config ./test/jest-e2e.json --runInBand --testRegex 'web-smoke/serve\.web-smoke\.ts$'
# 2. once /tmp/web-smoke/seed.json exists
pnpm --filter @jiwar/public build
WEB_SMOKE_DIR=/tmp/web-smoke pnpm --filter @jiwar/public smoke
touch /tmp/web-smoke/stop     # ends step 1
```

The partner's desk (`e2e/desk.spec.ts`) uses a seeded partner with a live desk link and a rotated one, and two requests starting within the hour: it accepts one (its gate pass shows) and declines the other. Run the API afresh before each smoke: a request is answered once.

`playwright` is pinned to the version whose Chromium build is already installed on the development machine; `playwright install` is not part of the flow.
