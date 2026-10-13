# 0041 — Push notifications: device tokens, the push outbox, FCM

**Status:** Accepted · Phase P1

## Context

Every notification is a row in the in-app inbox (ADR 0027), written by `Notifier.notify` in the transaction of the action that causes it. The inbox is only seen when the app is open. Since R1 (ADR 0036) an account has a per-category `push` switch, quiet hours and a pause, and `deliveryDecision` takes a `push` channel, but nothing sent a push.

This ADR adds delivery to the recipient's phones through Firebase Cloud Messaging (HTTP v1, which reaches Android and iOS). The inbox stays the source of truth: a push is a copy of an inbox row, never the other way round. Kinds and categories do not change.

## Decisions

### Device tokens

- `POST /me/push-tokens` `{ token, platform: android | ios }` and `DELETE /me/push-tokens`, for any signed-in tenant account (the resident and the staff apps; no permission). Both answer 204 with no body. Both need the `X-Jiwar-Install-Id` header the apps already send at login; without a UUID there the answer is 400 `INSTALL_ID_REQUIRED`.
- **One token per account and install.** The row is keyed by the account and the install's keyed hash (the same HMAC `known_devices` keeps; the install id itself is never stored). Registering again replaces the token in place.
- **One row per token, anywhere.** An FCM token names an app install. When that install signs in to another account, or to another compound, registering moves the token: the old row is deleted in the same transaction (`token_hash` is unique). Two registrations of one token take turns on an advisory lock.
- **At most 10 installs per account.** One more drops the least recently used.
- **Bound to a session.** The row carries the id of the session that registered it. This is what lets a logout remove "the token of this phone": the install id is not on the session, and a logout knows only the session.
- There is no route that lists devices, and no route returns a token.

### Why the tables are global

`push_devices` and `push_deliveries` have no RLS, like `sessions` and `outbox_messages`; `tenant_id` is a pointer and both are reached only through `GlobalDbService`. Three reasons:

1. A token lives and dies with a session, and `sessions` is global: a logout, a single revoke and refresh-token reuse run with no compound set and no tenant transaction.
2. "One row per token" must hold across compounds, and RLS would hide the other compound's row from the registration that has to delete it.
3. The worker claims due rows across compounds in one statement, like the email outbox.

Neither table is returned by any route. `push_deliveries` holds ids, a status and an error code: no token, no text.

### What ends a token

Each in the transaction that ends the session or the account's right to one:

| Event | Where |
|---|---|
| Logout; refresh-token reuse; a refresh on an account that may no longer sign in | `SessionService.revoke` (session and token in one transaction) |
| `POST /me/sessions/:id/revoke` | `AccountSelfService.revokeSession` (the same) |
| `POST /me/sessions/revoke-all`, deactivation, freeze, erasure | `AccountLifecycle` handlers, all of the account's tokens |
| A compound is suspended | `TenantsService.setStatus`, all of the compound's tokens |
| Erasure deletes the sessions | `ON DELETE CASCADE` from `sessions`, as a backstop |

Races are closed by locks, not by ordering luck:

- Registration runs under the account's row lock and re-checks the account and its own session there, with the session row locked `FOR SHARE`. A logout's `UPDATE` of that session waits, then deletes the row the registration just wrote; or it ran first and the registration is refused as signed out. Revoke-all, deactivation, freeze and erasure take the account lock themselves.
- **The worker checks again before every send**: the device's session must be unrevoked and unexpired and the account `active`, or the device is deleted and nothing is sent. This also covers a session that simply expired, which no code path ever writes.

### The push outbox

`Notifier.notify` calls `PushOutbox.enqueue` right after it writes the inbox rows, in the same transaction: one `push_deliveries` row per notification and registered device of its recipient. A notification that rolls back queues nothing.

This is a table of its own rather than a `push` channel on `outbox_messages` (which ADR 0019 anticipated). The email outbox carries a recipient address, a rendered template's params and a hold state. A push needs none of those and needs two things mail does not: a unique `(notification_id, device_id)`, and a foreign key to the device so that deleting a token deletes what was queued for it. ADR 0027's "delivery workers over the inbox" is what the worker does: it reads the notification row at send time.

### Preferences

Decided at enqueue with `deliveryDecision(prefs, kindDelivery(kind), 'push', now)`:

- a **critical** kind is always pushed;
- anything else is pushed only when the decision is "deliver now". A muted category, quiet hours and a pause (timed or "until resumed") all mean **no push**, not a later one.

This differs from email on purpose. A held email is still useful at 7 a.m.; a burst of pushes about yesterday evening is not, and the inbox has them. So push has no held state and nothing to re-decide when preferences change.

### Sending

`PushProcessor` has the shape of `OutboxProcessor`: an in-app `setTimeout` chain (`PUSH_ENABLED`, `PUSH_POLL_MS`), a claim in one statement (`FOR UPDATE SKIP LOCKED`, a 60 s lease, the attempt counted in the claim), and every later write fenced by that lease. For each claimed row it:

1. reads, in the row's compound, the notification as it is **now**, the account's status and language, the device and its session. A notification that is gone (erasure, retention) is dropped. Params scrubbed since the notification was written stay scrubbed;
2. renews the lease, so it only has to outlast one request, and sends outside any transaction;
3. records the answer:

| FCM says | Then |
|---|---|
| 200 | `sent`; the device's `last_used_at` is set |
| `UNREGISTERED`, `SENDER_ID_MISMATCH`, or `INVALID_ARGUMENT` **naming the token** | the device is deleted (its queue cascades); the log has the device id and the code |
| `INVALID_ARGUMENT` about anything else, or another refusal | `dead`, the token kept |
| 429, 5xx, 401/403 on our credentials, no connection, no OAuth token | back to `pending` after 30 s, 2 m, 10 m, 30 m (or `Retry-After` when longer); `dead` after `PUSH_MAX_ATTEMPTS` (5) with the last code |
| nothing (a timeout or a reset after the request left) | `dead`, never sent again |

`INVALID_ARGUMENT` is the one place this departs from "bad token, delete it": FCM answers a malformed message with the same code, and a bug in a payload would otherwise delete every device it was sent to. The token is condemned only when the error names `message.token` or says "registration token".

Finished rows are deleted after 7 days by a sweep task.

### At most once

A notification is pushed at most once per device:

- one row: `(notification_id, device_id)` is unique;
- one claimant: `SKIP LOCKED` and the lease; a run that lost its lease does not send (the renewal before the send fails);
- one send unless FCM said the first did not go: a retry follows an error answer or a connection that was never made. When the outcome is unknown the delivery is given up. That includes a sender that died mid-send: a lease that runs out is retired (`LEASE_EXPIRED`), not claimed again, which is the opposite of the email outbox's at-least-once.

A lost push is acceptable, because the inbox has the notification; a duplicate is not. As a second layer the message carries the notification id as Android `tag` and `apns-collapse-id`, so a phone that somehow got it twice shows it once.

### Text

A push is read on a lock screen before any app runs, so its text is written by the server: the second exception to "the backend returns no display text" (ADR 0013), after email.

- `src/core/push/push-texts.ts` has a title and a body per kind, in Arabic and English. The type is `Record<NotificationKind, Record<Locale, …>>`, so a kind without text does not compile, and `push-texts.spec` checks both languages, the lengths, and that Arabic is Arabic.
- No free text: a body may only name params the kind always carries.
- **No personal param, ever.** A visitor's or a worker's name stays in the inbox, behind the phone's lock; the push says "Your worker has arrived". The spec fails if a text names a personal param or if a rendered text contains one's value.
- No raw codes (a status, a carrier key): the app shows those.
- The language is the account's `preferred_locale` (Arabic by default).
- `data` is `{ notificationId, kind, targetType, targetId }`, strings, so the app opens the right screen.

### Configuration

- `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY`: the three fields of the Firebase service-account JSON, the key as a PEM on one line with its newlines written as `\n` (converted when loaded). The same lines as our other project (Jiwar-Hub), so one set of env lines serves both. All three or none: with only some set the app refuses to start and names the missing ones. At startup the email must look like one and the key must parse as a private RSA key (`node:crypto`); no error ever quotes a value.
- **Unset: push is off.** One startup line says so. Tokens are still accepted, so devices are ready when the keys arrive, but **no delivery rows are written**: nothing accumulates, and turning push on does not release a backlog of stale notifications.
- Auth is the service account's RS256 JWT, signed with `node:crypto` and exchanged for an OAuth token that is cached until a minute before it expires. No SDK and no new dependency.
- The transport is injected (`PUSH_TRANSPORT`). Tests use a fake; no test opens a socket. The test environment removes the FCM settings, so a developer's real project is never used.

### Secrets, export, erasure, audit

- The token is in `push_devices.token` and nowhere else: not in logs (ids and codes only), not in audit or security-event metadata, not in a response, not in the export. A test registers tokens, sends, fails and removes them, then looks for them in every table, every log line and every response.
- The export has `push-devices.json`: `id`, `platform`, `createdAt`, `lastUsedAt`.
- Erasure deletes the account's devices and their queue.
- **Registering and removing a token are not audited**, like `known_devices`: the app does it at every start, and every removal that matters follows an entry already recorded (`session.revoked`, `account.status_changed`, `account.frozen`, `account.erased`).

## Consequences

- A new notification kind needs its two texts in `push-texts.ts`; the build fails until it has them.
- A phone gets nothing after its session ends, and nothing for a compound that is suspended.
- An account that mutes a category, or is in quiet hours or paused, gets no push for non-critical kinds and finds them in the inbox.
- A push can be lost (an outage longer than the retries, a crash mid-send). The inbox is where a notification is guaranteed to be.
- Out of scope: web push for the dashboards, rich media, topic broadcasts, badges.
