# 0019 — Email outbox

**Status:** Accepted · Phase 2.1

## Context
Household and delegation emails were sent after commit, best effort. If SMTP was down at that moment, the email was gone. That broke the "never silent" promise (ADR 0016) exactly when it mattered, and nothing recorded the failure.

## Decisions
- **Transactional outbox.** `Outbox.enqueue(tx, …)` writes `outbox_messages` in the same transaction as the action:
  - the action rolls back → there is no message;
  - the message can't be written → the action rolls back;
  - an unknown template fails at enqueue.
- **What goes through it:** every non-OTP email (member removed, join rejected, delegation created, revoked or ended).
- **OTP emails (login and invite) stay direct.** The user is waiting, can ask for a new code, and a polling delay would only hurt.
- **Table:**
  - `outbox_messages` is global. `tenant_id` only says which compound caused the message, so the table is on the RLS allowlist.
  - The app may DELETE (the retention purge).
  - Columns: channel (`email`), `template_key`, locale, recipient, params, status (`pending` | `processing` | `sent` | `dead`), attempts, `next_attempt_at`, `locked_until`, `last_error_code` and timestamps.
- **Templates:** domains register renderers with the core `EmailTemplates` at startup, so core renders them without importing a domain (ADR 0015). Params are stored and rendered at send time.
- **Processor:** in-app, with no new infrastructure. Every `OUTBOX_POLL_MS` (default 5000) it:
  1. claims due messages, and messages whose lease expired (a sender that died), in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` statement. The claim sets a lease and commits. Several app instances never take the same message.
  2. sends each message **outside** any transaction, with `Message-ID <outbox-{id}@domain>`. Delivery is **at least once**: a crash between sending and marking can re-send, and the stable id lets a mail client recognize the duplicate.
  3. marks it `sent`; or schedules a retry after 1m → 5m → 30m → 2h → 6h (then every 6h); or, after `OUTBOX_MAX_ATTEMPTS` (default 8), marks it `dead` and logs the id and the error code. **Never the recipient or the body.**

  Updates after a send only apply while this processor still holds the lease.
- **Retention**, at most hourly:
  - **Sent** rows older than `OUTBOX_RETENTION_DAYS` (default 30) are deleted, since they contain email addresses.
  - **Dead** rows are **not** deleted. After the same period their `recipient` and `params` are stripped (`stripped_at`), and the template, compound, timestamps, attempts and error code stay. They are the only evidence that a "never silent" notice failed to reach someone.
  - A `CHECK` allows stripping only on dead rows, and only completely.
- **Switch:** `OUTBOX_ENABLED` (default true). The poller stops cleanly on shutdown and waits for the batch in flight. Tests run with it off and drain explicitly (`processDue(now)`, where `now` is a parameter so backoff can be tested without waiting).

## Future use
Worker notices (ADR 0017) and push/SMS will use this same outbox when those channels exist: a new channel value and a sender per channel.

## Known limits
- Nothing yet shows dead messages to a person who could act on them; that belongs with the manager notifications.
- An expired lease does not count as an attempt. A message that crashes the process on every try would be retried forever; a crash counter can be added when needed.
