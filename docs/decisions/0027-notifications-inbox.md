# 0027 — The notifications inbox

**Status:** Accepted · Phase 4

## Context
The gate needs to reach people inside a few minutes: a guard asking a household whether to let a visitor in, a household told that its worker arrived. Email is too slow and too noisy for that, and push and SMS need providers that are not chosen yet. Every later channel needs the same thing first: a durable record of what each account should be told.

## Decisions
- **One table, one row per recipient** (`notifications`, tenant-scoped with RLS). A row holds a catalog `kind`, its `priority` (`normal` or `critical`), `params`, and what it points at (`target_type`, `target_id`). Never display text: the apps render the kind in the reader's language (ADR 0013).
- **A catalog in core** (`src/core/notifications/kinds.ts`), like the audit catalog: each kind declares its priority, target and params. `Notifier.notify(tx, accountIds, { kind, params, targetId })` rejects an unknown kind, an unknown or missing param and a non-scalar value, and takes the priority and target type from the catalog. A unit test fails if a param name looks like a document, phone, email or code.
- **In the action's transaction.** `notify` writes with the caller's `tx`, so a notification exists exactly when the action that caused it committed, and never otherwise. Domains reach it through the `Notifier` provider; core never imports a domain.
- **Personal params** (`visitorName`, `workerName`) are marked in the catalog. When the data they came from expires (a visitor's details, ADR 0028), `Notifier.scrubPersonal` removes them from every notification about that target, read or not; the row and its other params stay.
- **Endpoints** under `/me/notifications`, for any signed-in tenant account and only for its own rows: the list (newest first, `?unread=true`), the unread and critical-unread counts (the badge), mark one read (idempotent; someone else's id is `NOTIFICATION_NOT_FOUND`) and mark all read.
- **Retention.** The sweep `notifications.retention` deletes read rows older than `NOTIFICATIONS_RETENTION_DAYS` (90). Unread rows stay until read. An erasure (ADR 0023) deletes the account's rows.
- **Not audited.** A notification records that someone was told, not that someone acted; the action itself is audited.
- **`SweepRunner.forEachTenant(fn)`** runs `fn` once per compound, each in its own tenant transaction, as the `system` actor; one compound failing is logged and does not stop the others. It is the one sweep helper allowed to call `runInTenantUnsafe` (`src/core/sweep/sweep-runner.ts` is on the ESLint allowlist), so new sweep tasks need no allowance of their own.

## Consequences
- Push (FCM/APNs) and SMS become delivery workers over this table, with the same idempotent claim pattern as the email outbox (ADR 0019); the domains do not change.
- Per-account preferences (mute a kind) come with the design; today every recipient the domain names gets the row.
