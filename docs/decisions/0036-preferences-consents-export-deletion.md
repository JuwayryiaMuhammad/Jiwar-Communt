# 0036 — Preferences, consents, data export and account deletion

**Status:** Accepted · Phase R1

## Context
Every account needs control over how it is reached, a way to say yes or no to a specific use of its data, a copy of its data, and a way to leave. Some people never use the app and need the management to do these things for them. Push notifications come next. They must read these preferences from their first day, so R1 lands first.

## Notification preferences

### Categories and critical kinds
- **Control is per category, never per kind:** `maintenance`, `gate_visitors`, `parcels`, `household`, `account_security`.
- **Every kind declares its category and `critical`** (`src/core/notifications/kinds.ts`); a unit test fails if one does not. `priority` stays as it was: it drives the inbox badge.
- **Every email template declares a delivery class** when it registers (`EmailTemplates.register(key, renderer, { category, critical, soleRecord })`).
- **Critical** means never muted and never held by quiet hours or a pause. A unit test pins the critical kinds to exactly these:
  - security: `account.new_device_login`, `entry_credential.issued` (a new entry device), and the email templates `account.frozen` and `account.frozen_not_me` (a frozen account has no session left to read an inbox);
  - emergency tickets: `ticket.emergency`, `ticket.unassignable_emergency`, `ticket.sla_breached_emergency`;
  - staff work: `ticket.assigned`, `gate.approval_requested` (it reaches the household; the guard is waiting at the gate), `gate.approval_reversed` (it tells the guard to stop an entry);
  - deletion notices: `account.deletion_requested` (the confirmation, own or assisted), `account.deletion_reminder`, `account.deletion_delayed`;
  - the email `data_export.link`, which answers an explicit request, like a code.
- **The inbox records everything** whatever the preferences say. Preferences decide only the delivery channels: `email` now, `push` later. Both are stored per category from R1 on; nothing reads `push` yet.

### Quiet hours and pause
- **Quiet hours** are a start and an end in local `HH:MM`, read in the compound's own time zone (`tenant_settings.timezone`, which already existed; default `Africa/Cairo`). A window whose end is before its start runs past midnight.
- **A pause** lasts 1 h, 8 h, or until turned back on.
- **Defaults are the absence of rows:** every switch on, no quiet hours, no pause, for every account kind. A new compound needs nothing, so no `TenantLifecycle.onCreated` handler.
- **Tables:**
  - `notification_settings`: one row per account, holding quiet hours and the pause;
  - `notification_channel_prefs`: one row per account, category and channel switch.

### `deliveryDecision(prefs, kind, channel, now)`
A pure function (`src/core/preferences/delivery-decision.ts`), unit-tested over every combination: critical or not, each channel, category on or off, sole record or not, quiet hours (same day, past midnight, edges), pause (none, active, ended, indefinite), and a day when the clocks change in Cairo. It returns `deliver`, `hold(until)` or `skip`:
1. a critical kind delivers;
2. a category × channel switched off skips, **unless the email is its notice's only record** (`soleRecord`);
3. a pause holds until it ends. A timed pause holds everything non-critical; a pause "until resumed" holds all but sole-record emails;
4. quiet hours hold until the window ends, including when a pause ends inside one.

Held deliveries are never dropped on their own; the 7-day retention below is the one exception.

### The outbox (refines decision 4)
- **Sole records.** Most emails today have no inbox row: household, delegation, community and most account notices. Skipping one would make it silent, against ADR 0016. Those templates are `soleRecord`:
  - a category switched off never skips them;
  - quiet hours and a timed pause hold them;
  - a pause "until resumed" does not hold them; under such a pause they are delivered at the end of any quiet window.

  Emails with an inbox twin (every R1 email) follow the preferences fully.
- **At enqueue.** `Outbox.enqueue` decides each message for an account in the action's transaction:
  - sent now;
  - or held: `held_at` set, `next_attempt_at` set to the end of the hold, or status `held` for an indefinite pause, which the processor never claims;
  - or not written at all (skipped; `enqueue` returns null).
- **On every preference change**, the same transaction decides again every held message of that account that nobody has tried yet. Turning a pause off releases the account's held mail at once.
- **Held for more than 7 days.** The outbox purge deletes a message with an inbox twin that has been held this long; the inbox stays its record. A sole-record email is never deleted this way.
- **Locking.** Every preference change locks the settings row (inserted first when missing), so two changes never lose each other's switches.

## Consents
- **A closed catalog in code** (`CONSENT_CATALOG`), each code with a version. The database repeats the codes as CHECKs, and a unit test keeps the two in step.
- **`consent_events` is append-only.** Each row is a grant or a revocation with:
  - the code and the version it answered;
  - who acted: the account, a manager for it (`assisted`, with a reason code), or the system;
  - SELECT and INSERT only for the app; triggers refuse UPDATE, DELETE and TRUNCATE for every role (the existing `ticket_history_is_immutable`).
- **`account_consents` is the current-state projection.** It is written with each event under its own row lock, and `ConsentsService.rebuild` rebuilds it from the events alone (a test compares the two).
- **Rules:**
  - A grant must answer the current version (`CONSENT_VERSION_MISMATCH`).
  - Bumping a version makes earlier grants stop counting until granted again.
  - Revoking is allowed at any time, and readers check at read time.
  - An erasure revokes what was granted, as the system.
- **The first code, `ticket_phone_share`,** is account-level and off by default. The technician's ticket detail (`GET /technician/tickets/{id}`) carries `reporterPhone`, and it is null unless all of these hold at read time:
  - the reader is the ticket's technician now;
  - the work is open (`assigned`, `in_progress`, `on_hold`);
  - the reporter is active (never frozen, erased or deactivated) and has a phone;
  - the reporter still holds `tickets` on the ticket's unit, the same check as a resident reader's cutoff (`CommunityMaintenancePort.ticketsLostAt` is null), so someone who left never has their phone shown; for a common area, `tickets` on any unit;
  - the consent is granted at its current version.

  Dispatch, residents and other technicians never see it. The PII scan allows exactly this one read and fails on every other case.

## Step-up
- `POST /me/step-up` emails a 6-digit code to the account's own address, sent directly like a login code.
- It is OTP purpose `step_up`, keyed `HMAC(pepper, "step-up:session:<sid>")`, so it is bound to the session that asked.
- `POST /me/step-up/verify` sets `sessions.step_up_until` for 10 minutes.
- The sensitive action consumes it in its own transaction (`StepUpService.consume`): one code opens one action, and a rolled-back action leaves it usable.
- Security events: `step_up.requested`, `step_up.verified`, `step_up.failed`.

## Personal-data export

### Content
- **Scope:** the account's own data in this compound, and what it authored. One account, so one capacity, not one person.
- **Sections** come from a registry (`ExportSections`, which core owns and domains register into). Each section reads as the account and through its own views, so it never shows another person's data beyond what those views already show.
- **Never in the archive:** another person's government ID number, birth date, document image or photo. Names stay as the account typed them.
- **The sections:**
  - **core:**
    - `account.json` (`GET /me`, the document masked, no photo URL);
    - `notification-preferences.json`;
    - `consents.json` (the state and the account's own history; who acted is `self`, `assisted` or `system`, never a manager's id);
    - `sessions.json` (never an IP);
    - `notifications/NNN.json` (the inbox);
    - `deletion-requests.json`;
    - `files/`: the account's own photo and the ready files it owns, as files.
  - **community:**
    - `units.json` (`GET /me/units`);
    - `permissions/<unitCode>.json` (a member's own permissions);
    - `delegations.json`;
    - `workers.json`: the domestic workers the account registered, with exactly `engagementId`, `unitCode`, `workerName` (the name on the worker's record), `capacity`, `schedule`, `validUntil`, `status`, `createdAt`, `updatedAt`. Never the worker's ID number, birth date, phone, document or photo.
  - **gate:**
    - `visitor-passes.json`: the passes it issued, with exactly `id`, `unitCode`, `kind`, `partySize`, `validFrom`, `validUntil`, `schedule`, `status`, `usedAt`, `cancelledAt`, `cancelReasonCode`, `createdAt` and `visitorName` (the name the account typed, while the pass's visitor details exist, ADR 0028). Never a code, a QR or the visitor's phone;
    - `entry-credentials.json` (`id`, `deviceName` while live, `createdAt`, `revokedAt`, `revokeReason`).
  - **maintenance:** `tickets/MT-000123.json`, one for every ticket the account opened or reported, as the resident's detail shows it, with its thread as the resident sees it. Photos are the ticket's records, so the archive has only their count, never a URL.

### Flow
- **Request.** `POST /me/data-exports` needs:
  - a fresh step-up on the session (`STEP_UP_REQUIRED`);
  - no active request (pending or building, `DATA_EXPORT_ACTIVE`; backed by a partial unique index);
  - no request in the last 24 hours (`DATA_EXPORT_RATE_LIMITED`, with `retryAfter`);
  - an account that is not frozen or erased (`ACCOUNT_NOT_ELIGIBLE`).

  All of it is checked under the account's row lock.
- **Build.** The `data_exports.build` sweep runs every minute:
  - It leases due requests (`SKIP LOCKED`, a 15-minute lease, 3 attempts) and builds each one outside any transaction, as the account.
  - Sections are read in short transactions and streamed into a zip (`fflate`), which flows into a multipart upload (`@aws-sdk/lib-storage`, 5 MB parts, one at a time). Neither an entry nor the archive is ever held whole: about 10 MB of memory.
  - Until its file row exists, the object is named by the request's `object_id`. A crashed build's object is deleted when the build is taken again.
  - Then, in one transaction:
    - the `data_export` file (a zip, at most 512 MiB) is attached to the request, which becomes ready for 7 days;
    - `data_export.ready` goes to the inbox, with no link;
    - an assisted request also gets the `data_export.link` email.
- **Download in the app:** `GET /me/data-exports/{id}/download` returns a presigned GET, no-store, as an attachment.
- **Download from the assisted email:** the link alone downloads nothing.
  - `POST /public/data-exports/code` emails a one-time code (the step-up mechanism, keyed `step-up:action-token:<id>`) to the account's own email.
  - `POST /public/data-exports/download` takes the link and the code and returns the presigned GET (no-store).
  - At most 3 successful downloads, then the link stops working (`ACTION_TOKEN_INVALID`). Each use is audited.
- **Expiry.** The `data_exports.expire` sweep marks the file deleted after 7 days, and the files sweep removes it.
- **Erasure** fails or expires the account's exports and deletes their files.
- **Audit:** `data_export.requested`, `.ready`, `.downloaded`, `.expired`, `.failed`, with ids, codes and counts only.

## Account deletion (amends ADR 0023)

### Blockers
They are checked on request (409 `DELETION_BLOCKED`, `params.blockers`) and again inside the executing transaction, under the account's row lock. Domains add their own through `AccountLifecycle.onDeletionCheck`.
- `primary_resident`: an active primary occupancy. Transfer the primary (ADR 0021) or end the occupancy first.
- `active_staff_role`: an active staff or manager account. Roles never cross account kinds (ADR 0010), so a resident can never gain one; the race is a staff account being reactivated.
- `legal_hold`: an open hold (ADR 0023 already blocked erasure on it).
- `open_worker_obligations`: an unsettled wage obligation on an engagement the account registered, or an open engagement of theirs that had a code. **Finding:** erasure already ended those engagements and recorded `settle_before_close` (ADR 0022), which left an open obligation pointing at an erased employer.

  Compliance cases (opened by management, attached to the worker), card incidents (the reporter is only a pointer) and delegations (they end with the account) are handled by erasure today, so none of them is a blocker.

### Cooling-off and execution
- `DELETION_GRACE_DAYS` now defaults to **14**. The account works normally meanwhile and can cancel.
- The account is told when the request is made, and two days before it runs (day 12, `account.deletion_reminder`); both are critical.
- After the cooling-off, the `accounts.deletion` sweep executes each due request in a transaction of its own, as the system:
  - it locks the account's row, reads the request again (a cancel may have won) and checks the blockers again;
  - with none, it runs the existing erasure;
  - with some, it queues the request with its codes (`queued`, `blocker_codes`) and tells the account (`account.deletion_delayed`, critical) and the `accounts.erase` holders (`account.deletion_queued`).
- "No scheduler erases by itself" (ADR 0023) no longer holds. The overdue report and its sweep are retired, and so is `ERASURE_OVERDUE_DAYS`.
- Requests filed before R1 keep their 30-day `effective_at`.
- **Managers** list pending and queued requests (`GET /erasures`, now with status and blockers). They either:
  - execute a queued one once it is clear: the existing three steps, with the blockers re-checked;
  - or close it with a reason code (`POST /erasures/{id}/close`: `blockers_unresolved`, `withdrawn`, `other`), and the account is told.
- When a family member's deletion executes, the unit's primary is told (`household.member_account_deleted`, inbox and email), with the unit's code only: no name, no reason.

### Races
- **The standing lock order is accounts first, then units** (`src/community/residents/account-locks.ts`). The execution holds the account row `FOR UPDATE` and then locks the units it leaves, so every write that can make an account a unit's primary, or end or deactivate it on a unit, takes the account rows before any unit lock:
  - `setPrimary`, `addOccupancy` and `convertToOwner` take the account `FOR KEY SHARE`;
  - registration approval takes the matching existing account `FOR KEY SHARE`;
  - `transferOwnership` takes the buyer, the unit's occupants and its household's members `FOR UPDATE`, in id order.
- **Execution against becoming primary.** Whichever runs second sees the other's commit: either the request is queued as a primary, or the account is erased and the write is refused (`setPrimary`, `transferOwnership`) or makes a new account (registration approval). Tests race the execution against `setPrimary` and against a `transferOwnership` to an account that already lives in the unit; neither may end in a deadlock error.
- **Execution against reactivation.** `AccountWriter.setStatus` and `reactivate` lock the row before they read it, and refuse an erased account; before R1 they could write `active` over a tombstone.
- **Cancel against execution.** Both lock the account row; the second finds the first's result.
- **The sweep** reads each request again under the lock, so it is safe on several instances.

## Unusual-login alert
- **"Unusual" means a device never seen on this account.**
  - The apps send `X-Jiwar-Install-Id` (a UUID made at install). Browsers are known by browser family and OS, read by a small classifier with no dependency.
  - `known_devices` keeps only `HMAC(IDENTIFIER_PEPPER, "device:v1:<accountId>:<source>:<material>")` and a coarse type (`ios`, `android`, `desktop_web`, `mobile_web`, `unknown`): no user agent, no IP, no geolocation.
  - Binding the hash to the account means one install can never be linked across accounts.
  - No new env var: the pepper already keys every identifier and code HMAC with a domain prefix, and `ENTRY_CREDENTIAL_KEY` stays the QR's alone (ADR 0031).
  - The header is redacted from logs.
- **The check runs at every login,** before the session is issued, under the account's row lock (`FOR NO KEY UPDATE`). It is fail-closed: a login that cannot record its device does not start.
  - The first device is the baseline and raises nothing. That also covers an account that only logged in before R1: its baseline is its next login.
  - A new device raises `account.new_device_login`, critical, in the inbox and by email, with `deviceType` and `at` only, and security event `login.new_device`.
- **"Not me"** reuses the ADR 0023 freeze with a new reason, **`login_not_me`, which keeps the phone**:
  - from the app: `POST /me/devices/{id}/not-me`, on the device the alert named;
  - from the email's link: `POST /public/not-me`, single use, valid 72 h;
  - either way: frozen, every session and code ends, the domains react (`onFrozen`), the device is marked disowned, and the holder is told (`account.frozen_not_me`);
  - `account_freezes.released_phone_hash` is set only for `phone_reassigned` (CHECK), and a manager's `reactivate` needs no new phone;
  - security event `account.not_me`.

## Assisted path
- **`residents.assist`** belongs to the manager role by default; `access:sync` adds it to existing compounds.
- It opens `GET/PATCH /accounts/{id}/notification-preferences`, `GET /accounts/{id}/consents` and `POST …/consents/grant` and `/revoke`, `POST /accounts/{id}/data-exports`, and `POST /accounts/{id}/deletion-request` and `/cancel`.
- The account must be a resident or family account, not erased (`ACCOUNT_NOT_FOUND` otherwise).
- **Every action:**
  - takes a reason code: `in_person`, `phone_call`, `written_request`;
  - is marked assisted in its own events and audit entry;
  - tells the account (`account.assisted_action`, inbox and email: what was done and how it was asked, never who).
- **An assisted export goes only to the account's own email**: the manager's response carries no link, and the manager can never download it. An account without an email would be refused (`ACCOUNT_HAS_NO_EMAIL`). Today that cannot happen, because every account that may export has an email (`accounts_erased_shape`), so a unit test proves the guard.
- **Cancel** is allowed too, so a request filed by mistake can be undone without the person logging in.
- **Where things stand:** `GET /accounts/{id}/deletion-request` (the latest request, `DELETION_REQUEST_NOT_FOUND` when there is none) and `GET /accounts/{id}/data-exports` (the latest ten) return status, dates and `assisted`, so the manager can answer the person. Never a link or a token. Reading tells nobody and is not audited.

## Secrets in emails
- **The token.** Emails carrying a "not me" action or a download link carry an action token. `action_tokens` is a global pointer, like `invite_tokens`, on the RLS allowlist. It holds ids, purpose, subject, account, expiry and use count, and no secret or hash of one.
  - The token is `<id>.<mac>`, with `mac = HMAC(IDENTIFIER_PEPPER, "action-token:v1:<purpose>:<id>")`: only the server can make or check one, and it is bound to its purpose.
- **Rendered at send time.** The outbox stores only the row's id; the template's renderer derives the link as the email is sent, and a resend carries the same link.
- **One page per purpose:** `<PUBLIC_APP_URL>/a/not-me#<token>` and `<PUBLIC_APP_URL>/a/export#<token>`. The web app has to know what to ask before it calls anything (a freeze needs a confirmation), and `<id>.<mac>` does not say; the purpose is no secret. The page's contract is in `docs/api/v0-notes.md`.
- **Never stored or logged.** The fragment never reaches a server log, and the web app posts the token in a body, which is never logged.
- **Proof.** A secrets scan takes both tokens from the emails actually sent and finds them in no outbox row, audit entry, security event, notification, idempotency row, token row or log line.

## PII
- Codes, ids and times only in audit entries, notifications, consent events and export records; never content.
- No IP in any notification. Known devices keep a keyed hash and a coarse type.
- A reporter's phone reaches only the consented technician, under the read-time rule.
- The archive lives only in the private bucket, for 7 days, behind short-lived presigned URLs in no-store responses.
- Erasure deletes devices, tokens and preferences; appends system revocations of consents; fails or expires exports and deletes their files.

## Consequences
- Push delivery reads `notification_channel_prefs` (`push`) and `deliveryDecision` with `channel = 'push'`; the domains do not change.
- A new email template must declare its delivery class, or it does not compile.
- A new write that makes an account a unit's primary, or ends or deactivates an account on a unit, must take the account rows first (`account-locks.ts`). An account that joins a unit between that read and the unit lock is locked after the unit, as before R1.
- Out of R1: push and SMS delivery; partner, marketing and directory consents; a per-compound retention policy.
