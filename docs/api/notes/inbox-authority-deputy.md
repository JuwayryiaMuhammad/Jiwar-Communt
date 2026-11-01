# The staff inbox, the board's binding authority and the deputy: backend notes for the dashboard and staff apps

What was built for the manager and the staff who decide things:
- one inbox over what waits for a decision, across the compound, with due times and an overdue notice;
- a bulk approval of the items whose approval takes no input;
- the waiver's and the payment plan's thresholds made binding, with the board's authorization used once;
- a deputy who decides in the manager's place for up to 30 days;
- a notification flag for what asks for a decision, and unread critical notifications kept until read.

The design decisions are in [ADR 0073](../../decisions/0073-inbox-authority-deputy.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection. Conventions are API v0's (see [community-life](community-life.md)).

## The inbox

- `GET /staff/inbox?type=&overdue=true&cursor=&limit=` (`inbox.read`): oldest first. Only the types whose permission the caller holds. Each row has:
  - `type`, `id`, `number` (or null), `kind` (a code), `status` (its domain's), `unitId`;
  - `requestedAt`, `dueAt`, `overdue`;
  - `amount` (EGP, a thresholded type only) and `authority` (`{ limit, decider: "manager" | "board" }`, or null);
  - `bulk`.
- **Deciding.** Open the row on its own domain's page and decide there, with that route and its errors. The inbox does not decide.
- `POST /staff/inbox/bulk-approve` `{ items: [{ type, id }] }` (1–50): only rows with `bulk: true` (a type that takes input is `INVALID_VALUE` on `items[i].type`; one the caller does not decide is 403).
  - The answer has one outcome per item: `approved`, or `failed` with the `code` its own route would have answered (`PERMIT_NOT_PENDING`, …).
  - Show the failed ones; the others are done.
- `GET /staff/inbox/count`: `{ total, overdue, types: [{ type, total, overdue }] }`, for the badge.
- `GET /staff/inbox/settings` and `PATCH` `{ items: [{ type, dueHours }] }` (`settings.manage`; 1–720 hours, or `null` back to the default).
- **The overdue notice:** `staff_inbox.overdue` (`params.itemType`, `targetId` the item's own id) goes once per item to whoever decides its type. Open the inbox filtered by that type.

## The board's authority

- `GET`/`PATCH /staff/governance/settings`: each type gains `binding` and `bindable`. Set `binding` on `waiver_above_limit` and `payment_plan_above_limit` only. `major_contract` always binds.
- A waiver or payment plan approval request now requires `cost`.
- **Above a binding threshold**, `POST /staff/invoice-disputes/{id}/decide` (accept) and the plan routes (`POST /staff/invoices/{id}/instalment-plan`, `POST /staff/plan-requests/{id}/accept`) take `authorizationId`, an approved request's authorization:
  - `GET /staff/finance/board-authorizations?type=&unused=true` lists them;
  - without one: `409 NEEDS_BOARD_APPROVAL` (`params.type`, `params.limit`);
  - an unknown one, or one of the other type: `404 BOARD_AUTHORIZATION_NOT_FOUND`;
  - past its cost: `409 BOARD_AUTHORIZATION_EXCEEDED` (`params.amount`);
  - used already: `409 BOARD_AUTHORIZATION_USED`.
- Within the threshold, `authorizationId` is `FIELD_NOT_ALLOWED`.

## The deputy

- `POST /staff/deputies` (`deputies.manage`) `{ deputyAccountId, permissions: [...], endsAt }`:
  - the deputy is an active staff or manager account, not the caller;
  - the permissions come out of the caller's own role, never `finance.*`, `governance.*`, `appeals.decide`, `roles.manage` or `deputies.manage` (`INVALID_VALUE` with `params.permission`);
  - `endsAt` is after now and at most 30 days ahead (`params.maxDays`).
  - The caller already has a live deputy: `409 DEPUTY_ALREADY_SET`. The deputy is someone's already: `409 DEPUTY_BUSY`.
- Meanwhile the deputy holds the permissions and the caller does not. `GET /me`'s `permissions` shows each side its own; refresh it after naming or ending one.
- `GET /staff/deputies`: the caller's deputyships, `role: principal | deputy`, `live`, `endReason` (`ended`, `expired`, `account_left`).
- `POST /staff/deputies/{id}/end`: by either account, once (`409 DEPUTY_ENDED`).
- Notifications: `deputy.appointed` (`params.permissions`, a count) and `deputy.ended` (`params.reason`).
- Audit entries carry `onBehalfOfId`: the principal, for what a deputy did through a gained permission.

## Notifications

- Every notification has `needsDecision`; `GET /me/notifications?needsDecision=true` lists only those.
- An unread `critical` one cannot be archived or deleted: `409 NOTIFICATION_CRITICAL_UNREAD`. Mark it read first.
