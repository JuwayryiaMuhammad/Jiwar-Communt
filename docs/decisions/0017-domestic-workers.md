# 0017 — Domestic workers

**Status:** Accepted · Phase 2 (resident and management side; the gate comes next)

## Context
Housekeepers, drivers, nannies and live-in helpers come and go every day. The journeys call them the most vulnerable users: many have no smartphone, a printed card is their primary credential, and anything that affects them must be explained to them, never done silently. Residents must be able to arrange them without learning anything about the worker's other households.

## Decisions
- **No account, no login.** A worker is known to a compound once, by `HMAC(pepper, "worker-national-id:<id>")` (`domestic_workers`, unique per compound). Each unit they serve is an **engagement** (`worker_engagements`).
- **Who may act:**
  - **Registering:** an occupant of the unit (any active occupancy) or a live `workers` delegate. A plain household member cannot. Requires `workers.manage`.
  - **Suspend, resume, end, reissue:** the engagement's requester (while they still see the unit), the unit's primary, a `workers` delegate, or a manager.
  - **Review:** manager only (`workers.review`).
  - **Ban:** manager only (`workers.ban`).
- **Registration:**
  - the national ID is validated; **under 18 is `WORKER_UNDERAGE`, with no override of any kind**;
  - an existing record is reused **as it is**, and nothing about it is returned;
  - a banned worker is `WORKER_BLOCKED_BY_MANAGEMENT`;
  - the engagement starts `pending_review`.
- **Schedule conflicts are a warning, not an error.**
  - Schedules are days plus time windows; a live-in worker has an empty schedule, which overlaps everything.
  - An overlap with the worker's active engagements in **other** units returns `{ code: 'WORKER_SCHEDULE_CONFLICT' }` and nothing else: no unit, no count, no detail. Registration goes on.
- **Access codes:**
  - A code is 8 digits (`crypto.randomInt`), returned once. Only `HMAC(pepper, "worker-code:<tenant>:<code>")` is stored, unique among the compound's active engagements.
  - A code has **no expiry of its own**: it works exactly while its engagement is `active` and not past `valid_until`. `WorkersService.isCodeValid` is the single check the gate will use.
  - **Suspension** (by a resident or by a ban) **keeps** the code but it stops working; nothing needs reprinting.
  - **Resume** brings the same code back. If another active engagement received the same code meanwhile (the unique index only covers active ones), a new code is issued, returned once, and recorded as `codeReplaced`.
  - The code is destroyed only by end, temporary expiry, reissue (lost or confiscated card) and rejection. A `CHECK` ties the code to the status.
- **Never silent:** every suspension, resumption and end writes a `worker_notices` row (key + reason) in the same transaction. Nothing sends them yet; the SMS/WhatsApp channel will.
- **Temporary work ends by itself.** Past `valid_until`, an engagement reads as ended, and its code is invalid. The first write that touches it persists `ended` / `expired` with a notice and an audit entry by `system`, and that write commits; the requested change is then refused. There is no cron.
- **Ban:**
  - every active engagement is suspended by management (`suspended_by_management`), with a notice each;
  - residents see the status and the flag, **never the reason or other units**;
  - while the ban holds, nobody can resume;
  - `unban` lifts the ban only, and engagements stay suspended until resumed.
- **Privacy:**
  - resident reads return only engagements on the resident's own units: worker name, capacity, schedule, status, `validUntil`, `suspendedByManagement`;
  - never a national ID, another unit, or an engagement count.
- **Audit:** `worker.registered`, `worker.engagement_reviewed`, `worker.code_reissued`, `worker.engagement_suspended`, `_resumed`, `_ended`, `worker.banned`, `worker.unbanned`. Codes and reasons never enter the trail.

## Deferred
- **Gate:** verifying codes, attendance, and entry/exit notifications to the resident.
- Wages, printed cards, photos and object storage, and delivery of notices.
- Overnight windows (a window that crosses midnight) are rejected for now; the design decides how they are entered.
