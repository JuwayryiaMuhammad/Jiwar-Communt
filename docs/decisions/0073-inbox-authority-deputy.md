# 0073 — The manager's inbox, the board's binding authority and the deputy

**Status:** Accepted · Phase M2-3 · amends ADR 0010 (one role per account), 0055 (thresholds), 0058 (the inbox's archive)

## Context

The manager audit (2026-11-01) found that what waits for a staff decision is spread over a dozen queues, most with no due time. The overview page also built three of them itself from pages of 100 rows. Approvals had one level: the board for every type, with only the major contract's threshold enforced. A manager away from the compound had no way to let someone decide in their place. The spec also forbids archiving an unread critical notification. No ADR said so: ADR 0058's archive marked any notification read, so this is a new rule, not a fix of an old one.

## Decisions

### 1. The staff inbox

- **A registry in core (`StaffInbox`), as `ResidentItems` and `BoardMatters`.** Each domain registers its pending items at startup. Core imports no domain, and every source reads in the caller's tenant transaction with the visibility of its own queue.
- **Twelve types:**
  - `registration`
  - `identity_change`
  - `worker_engagement`
  - `vehicle`
  - `booking` (one that requires approval)
  - `unit_permit`
  - `work_permit`
  - `field_exception`
  - `plan_request`
  - `invoice_dispute`
  - `decision_appeal`
  - `management_request` (open or in progress)

  A type shows only to the holders of its own permission (the permission its own queue needs).
- **Routes** (`inbox.read`: the manager, the two supervisors and the accountant by default):
  - `GET /staff/inbox`: oldest first, with `?type=` and `?overdue=true`. A row has:
    - its reference, kind and status;
    - `requestedAt`, `dueAt` and `overdue`;
    - for a thresholded type, `authority`: the threshold, and `decider` = `board` above it;
    - `bulk`.
  - `GET /staff/inbox/count`: the totals and the overdue, per type.
  - `POST /staff/inbox/bulk-approve` (at most 50).
  - `GET`/`PATCH /staff/inbox/settings`: changing them needs `settings.manage`.
- **The inbox decides nothing.** Every decision is its domain's own route, with its own locks, triggers and reasons. The dashboard opens each row on its own page.
  - The one exception is a bulk approval of the types whose approval takes no input: a unit permit, a booking, a work permit and a name or phone change.
  - The inbox calls the domain's own approve for each item, each in its own transaction, as the caller. One refused (the domain's own error code) leaves the others.
- **Due times.**
  - The code's defaults, in hours: registration 72, identity change 48, worker 48, vehicle 72, booking 24, unit permit 24, work permit 2, field exception 1, plan request 72, dispute 120, decision appeal 120, management request 72.
  - The compound sets its own per type, 1–720 hours (`staff_inbox_due_hours`; null back to the default), under an advisory lock. Audited as `staff_inbox.settings_changed`.
- **The overdue notice.** The sweep `staff_inbox.overdue` (every 15 minutes) tells the holders of an overdue item's permission (`staff_inbox.overdue`, `itemType` only).
  - Each item is told once, ever: `staff_inbox_overdue`'s key, `INSERT … ON CONFLICT DO NOTHING`.
  - So two runs at once, or a run after the due time moved, tell nobody twice.
  - At most 500 items of a type are looked at per run.

### 2. The board's authority, binding

- **`governance_approval_settings.binding`.**
  - Always true for `major_contract`: the manager's limit for one expense, as before.
  - A setting for `waiver_above_limit` and `payment_plan_above_limit`.
  - Never for the rest (a CHECK). `exceptional_fee` stays advisory, because nothing charges one yet.
  - `GET`/`PATCH /staff/governance/settings` show and take it (`FIELD_NOT_ALLOWED` on a type that may not bind). Core reads it through `BoardMatters.binding`, its row shared-locked like the threshold's.
- **A waiver or a payment plan request now names its cost.** An approved one grants a `finance_board_authorizations` row of its cost, through finance's handler for the type (`board_authorization.granted`).
- **Finance holds the credit and the plan to the threshold.**
  - A dispute's accepted credit, and a plan (the staff's convert and a resident's plan request alike, in `convertLocked`), above a binding threshold must name an authorization (`authorizationId`):
    - `NEEDS_BOARD_APPROVAL` (params: type, limit) without one;
    - `BOARD_AUTHORIZATION_NOT_FOUND` for an unknown one, or one of the other type;
    - `BOARD_AUTHORIZATION_EXCEEDED` (params: amount) past its cost;
    - `BOARD_AUTHORIZATION_USED` when it served one already.
  - Within the threshold, `authorizationId` is `FIELD_NOT_ALLOWED`.
  - The authorization's row is locked `FOR UPDATE` after the caller's own locks and used once, by what it served (a trigger keeps the terms fixed and the use once). Audited as `board_authorization.used`.
  - `GET /staff/finance/board-authorizations` (`finance.invoice`) lists them.

### 3. A deputy (amends ADR 0010)

- **`account_deputies`.** A manager (`deputies.manage`) names another active staff or manager account to decide in their place:
  - from now, for at most 30 days;
  - with permissions out of their own role, and only those the deputy's kind may hold;
  - never `finance.*`, `governance.*`, `appeals.decide`, `roles.manage` or `deputies.manage`;
  - one live deputy per principal, and one live deputyship per deputy (partial unique keys, under both accounts' locks in id order).
- **In force.** `accounts.deputy_until` holds the latest end of the account's live deputyships, either side, set by every appointment and end under both accounts' locks. `PermissionsGuard` already reads the account row; only while that time is ahead does it read the deputyships:
  - The deputy's set gains the permissions, as long as the principal is still active.
  - The principal's set loses them, so the two never decide the same thing.
  - `PermissionsService.current()` gives the same set, and so does `StaffRecipients`: the deputy is told, not the principal.
- **On the principal's behalf.** A route allowed only through a gained permission sets `audit_log.on_behalf_of_id` on every entry the request writes. `GET /audit` shows it.
- **Ended once** (`deputy.ended`; the other side is told), in one of three ways:
  - by either account (`POST /staff/deputies/{id}/end`): `ended`;
  - by the sweep `deputies.expiry` (every 5 minutes) when its time ran out: `expired`;
  - by the same sweep when one of the two is no longer active: `account_left`.
- **The deputy is told when named** (`deputy.appointed`: the number of permissions). `GET /staff/deputies` lists the caller's deputyships, on either side.

### 4. Notifications (amends ADR 0058)

- **`needsDecision`, a flag of the catalog, not a column.**
  - It is on the 31 kinds that ask their recipient to approve, answer, accept or vote, and on `staff_inbox.overdue`.
  - Every notification shows it, and `?needsDecision=true` lists only those.
- **An unread critical notification is kept until read.** Archiving or deleting one is `409 NOTIFICATION_CRITICAL_UNREAD`. Read, it goes like any other.

## Deviations from the plan (for the owner)

1. **Decisions in the inbox are each domain's own route.** The dashboard opens the row's page. The inbox's own write is the bulk approval of the four types that take no input, through each domain's approve. A generic decide route with a polymorphic body would duplicate every domain's validation and contract.
2. **Role limits within the manager's level are not built.** The matrix has two levels per thresholded type: the manager up to the threshold, the board above it, binding or not. Limits per staff role (an accountant up to a smaller amount) can come with M3's payables.
3. **The waiver and the payment plan requests now require a cost.** What the board approves is what finance may then credit or spread.
4. **A deputyship starts when it is made.** Naming one ahead of an absence is not built.
5. **Delete is refused too** for an unread critical notification, not only archive.
6. **References in the inbox.** A vehicle shows `VH-`, a field exception `FE-`; a plan request, a dispute, a booking, a registration, a worker and a work permit show none.

## Consequences

- The overview and the M2-4 dashboard read counts from `GET /staff/inbox/count` instead of paging.
- A new pending type registers a source, and the staff_inbox CHECKs widen with a migration.
- An account with no deputyship pays nothing for them: the guard reads its `deputy_until` with the account it already reads. One that has one makes one more read per request while it lasts.

## Open

- An inbox row's amount for a dispute is null: the credit is chosen at the decision.
- An inspection campaign's or a part request's waiting items are not in the inbox yet.

## Update (Phase M2-4, ADR 0079)
- The operations dashboard reads the inbox's count for its badge and the inbox's own list for "needs you now" (its overdue items, then its oldest). The daily brief keeps every type's count (`countAll`), read back to each reader by the types they decide.

## Update (M2-12b, ADR 0090)
- Three more types: `dangling_account` (`accounts.manage`, 7 days), `access_review` (`accounts.manage`, 14 days: the review's overdue notice is the inbox's own) and `reinforcement_suggestion` (`field_team.manage`, 1 hour). None in bulk. Both CHECKs are recreated with every type in 20270614090500.

## Update (Phase M3-5, ADR 0092)
- One more type: `gl_manual_entry` (`finance.ledger_write`, 72 hours): a manual journal entry waiting for its second person; never in bulk (its maker never approves it). Both CHECKs are recreated with every type in 20270615090400.
