# Account checks: dangling accounts and access reviews (ADR 0090)

For the manager dashboard. `accounts.manage`; the compound's side only (staff, manager, contractor accounts).

## Settings

`GET|PATCH /staff/access/settings {idleDays?, reviewEveryDays?}`: 60 idle days (14–365), a review every 90 days (30–365).

## Dangling accounts

An active account is dangling when it is idle (no sign-in for the idle days), never signed into within 14 days of its creation, or a contractor whose vendor is suspended. Found hourly, told once (`dangling_account.found`, `params.reason`), and the inbox item `dangling_account`.

| Route | |
|---|---|
| `GET /staff/access/dangling-accounts?status` | `open`, `kept`, `deactivated`, `cleared`; newest first |
| `GET …/{id}` | One finding: `account`, `accountType`, `reason`, `lastActiveAt`, `foundAt`, `status`, `mutedUntil` |
| `POST …/{id}/keep {reasonCode}` | `danglingKeep`; not found again for 90 days |
| `POST …/{id}/deactivate` | The account is deactivated at once |

## Access reviews

A frozen snapshot of every active account of the compound's side: opened by the sweep every `reviewEveryDays`, or by hand. The inbox item `access_review`, due in 14 days.

| Route | |
|---|---|
| `GET /staff/access/reviews` | Newest first: `number` (`AR-000001`), `status`, `lines`, `kept`, `revoked`, `left`, `undecided` |
| `POST /staff/access/reviews` | Open one now |
| `GET …/{id}` | With `reviewLines`: `account`, `accountType`, `role {id, key, name}`, `permissions`, `lastActiveAt`, `protected`, `decision` |
| `POST …/{id}/lines/{lineId}/decide {decision: keep \| revoke}` | Once; revoke deactivates the account; the review closes with its last line |

| Error | When |
|---|---|
| 409 `CANNOT_CHANGE_OWN_STATUS` | Deciding a finding about one's own account. |
| 409 `DANGLING_ACCOUNT_DECIDED {status}` | The finding was decided or cleared. |
| 409 `ACCESS_REVIEW_OPEN` | A review is open already. |
| 403 `ACCESS_REVIEW_OWN_LINE` | One's own line. |
| 409 `ACCESS_REVIEW_LINE_PROTECTED` | Revoking the system manager's line. |
| 409 `ACCESS_REVIEW_LINE_DECIDED {decision}` | The line was decided (or its account left). |
| 409 `ACCESS_REVIEW_CLOSED` | The review is closed. |
