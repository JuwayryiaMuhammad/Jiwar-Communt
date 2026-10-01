# 0030 — QR entry: one token, derived codes, the visitor's link, the card

**Status:** Accepted · Phase 4.1

## Context
Until now the guard typed a 6-digit visitor code or an 8-digit worker code (ADR 0028). The apps need three more things. Guards should scan a QR. A visitor should open the link the host sends and find everything there, with no account: "the link itself is the verification" (journey 10). And a worker needs a printed card: "the printed card is the original" (journey 11). Each needs the secret again after it was issued, but the server must not store it.

## Decisions

### One secret, the code derived from it
- A pass gets a **token** of 32 random bytes (base64url, 43 characters) when it is created. So does a worker engagement when it is approved. A reissue gives a new one, and so does a resume that has to replace the code. The QR encodes `JWR1.<token>`. The versioned prefix lets the guard app tell a Jiwar QR apart.
- **The short code is derived, not drawn:** `HMAC(pepper, "code:<token>")`. The first 64 bits are taken modulo 10⁶ for a visitor and 10⁸ for a worker. The bias is negligible. If the derived code collides with another live code in the compound, the server draws a new token, never a new code. `AccessTokens.issue` does this for both domains (core, because community and gate both issue them).
- **Only HMACs are stored.**
  - `code_hash` stays the lookup for a typed code.
  - `qr_token_hash = HMAC(pepper, "qr:<tenant>:<token>")` is the lookup for a scanned QR. It is bound to the compound like the code, so another compound's QR is simply unknown.
  - Anyone holding the token can show both the QR and the code. The server can show neither once the response has gone.
- **The token lives and dies with the code.**
  - A CHECK allows a token hash only beside a live code: an active pass, or an active or suspended engagement. A partial unique index covers the live rows.
  - A **trigger** refuses an UPDATE that changes the code hash while the token hash stays the same. So an old QR cannot outlive a reissue, whichever code path writes it.
  - Suspension keeps both, and resume restores both. End, expiry, one-time use, cancellation, rejection and reissue clear or rotate both together.
- **Passes and engagements from before 4.1** have no token. They keep working by code. A QR, a link and a card come with their next reissue. Nothing is backfilled, because the codes were never stored and cannot be.

### At the gate
- `POST /gate/verify` takes exactly one of `code` or `qr`. Sending neither gives `code` FIELD_REQUIRED; sending both gives `qr` FIELD_NOT_ALLOWED.
- A QR is the code by other means: same response, same reasons, same per-guard rate limit (one budget for both).
- An unknown, malformed, dead or foreign QR is byte-identical to an unknown code.
- `POST /gate/entries` takes `via: 'code' | 'qr'` (default `code`). It is recorded as the entry's method when a pass or a worker code lets someone in. Exits and approvals keep their own method.
- A suspended engagement keeps its code, and codes are unique among active engagements only, so two rows can carry one code. The lookup prefers the active one. (Before this, a typed code could resolve to the suspended row and refuse the active worker.)

### The visitor's link and page
- **The link is `<PUBLIC_APP_URL>/v#<token>`.** The token is in the fragment, which browsers never send to a server, so it cannot land in an access log or a referrer. The page reads it and POSTs it. Request bodies are never logged.
- **The global pointer:** the page knows no compound yet, so `visitor_pass_links` maps `HMAC(pepper, "visitor-link:<token>")` to (compound, pass), like `invite_tokens` (ADR 0016) and `registration_links` (ADR 0024). It holds no PII, has no RLS, and the app may SELECT, INSERT and DELETE it.
  - It **outlives the code**, so the page can say the pass was used, expired or cancelled.
  - It is deleted when the link is reissued, and by the visitor-data sweep 30 days after the pass ends (ADR 0028).
- **`POST /public/visitor-passes/lookup {token}`** returns: the compound's name, the unit code, the pass's kind, size, window, time zone and schedule, its status, and the compound's `visitorDirections` and `emergencyPhone` (new manager settings).
  - `code` and `qrPayload` are returned only while the pass is active.
  - For a cancelled pass, `statusReason` is `wrong_recipient`, or `host_cancelled` for everything else (the host cancelled, or the host left). Nothing about security is ever said.
  - It never returns the host (name, phone or account), another resident, the guard, or the visitor's own name and phone.
- **`POST /public/visitor-passes/not-me {token}`** handles "this isn't me". It cancels the pass with reason `wrong_recipient`, under the same row lock as entries and the host's cancel. It tells the host with a normal-priority notification (`visitor_pass.not_me`, the unit code only). The audit is `visitor_pass.cancelled`, with actor `system` and `metadata.reasonCode`. It asks the visitor nothing.
- **One 404** (`VISITOR_PASS_NOT_FOUND`) answers every token that is not a live link: unknown, malformed, replaced, retained no longer, a worker's token, a suspended compound's pass. `not-me` also answers it for a pass that is no longer active, so a second call looks exactly like an unknown token. Since the page knows no compound, another compound's live link is simply that compound's page: there is no "foreign" link.
- **Rate limits** come first: per IP and per link (`VISITOR_PAGE_RATE_LIMIT_PER_IP`, `…_PER_TOKEN`, per minute), shared by both routes. `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` are set before the handler, so 404 and 429 responses carry them too.
- **The host gets the link once.** It comes with the pass's creation (`code`, `link`, `qrPayload`, no-store). A host who loses it calls `POST /visitor-passes/:id/reissue-link`. Only the host or the unit's primary may, and only for an active pass (anything else is `VISITOR_PASS_NOT_FOUND`). The same pass gets a new token: a new link, QR and code. The old ones are dead at commit, and the old pointer is deleted in the same transaction. It is audited `visitor_pass.code_reissued`. The host does not need to cancel and recreate.
- **Idempotency without storing a secret:** `@Idempotent({ secret: true })` claims the key in the action's transaction (ADR 0028) but never stores the response body. A replay is rendered by reissuing again, which is the create replay's rule too. If two duplicates race, the earlier response's link dies, which is rare and better than a retry that cannot get a usable link.

### The worker's card
- Approval, reissue, a card incident and a resume that had to replace the code return a `card` block, once (no-store). It has: `qrPayload`, `code`, `workerName`, `capacity`, `unitCode`, `compoundName`, `schedule`, `validUntil`, `securityPhone` (the compound's emergency phone), and `preferredLanguage`. The client resolves the labels in that language.
- **There is no GET for card data.** The token is not stored, so a lost card means a reissue. A reissue is free and already audited, as a card incident or `worker.code_reissued` (ADR 0022).
- The PDF and the worker's photo wait for file storage.

## Consequences
- `PUBLIC_APP_URL` is required. It must be https in production, so a deploy without it does not boot.
- Workers have no API to set their language yet. The card carries the column's default (`ar`) until registration takes one.
- A pass's link cannot be shown again, only reissued. The host's pass list never carries a token.
- A host who shared the link with the wrong person learns it from the notification. The visitor learns only `wrong_recipient` and the compound's name, the unit code and the directions they had already seen.
